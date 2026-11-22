use rusqlite::Connection;
use sha2::{Digest, Sha256};
use yrs::{
    updates::decoder::Decode, Any, DeleteSet, Doc, Out, ReadTxn, StateVector, Text, Transact,
    TransactionMut, Update, Xml, XmlElementPrelim, XmlFragment, XmlOut, XmlTextPrelim,
};

use crate::{db_err, CommandResult};

use super::Move;

pub(crate) struct SectionConflict {
    pub(crate) module_id: String,
    pub(crate) content: Vec<u8>,
    pub(crate) source_cut: Option<Vec<u8>>,
}

pub(super) fn chapter_range(
    root: &impl XmlFragment,
    txn: &impl ReadTxn,
    id: &str,
) -> Option<(u32, u32)> {
    let mut chapter = None;
    for (index, node) in root.children(txn).enumerate() {
        let XmlOut::Element(element) = node else {
            continue;
        };
        if element.tag().as_ref() != "heading" {
            continue;
        }
        let h1 = match element.get_attribute(txn, "level") {
            Some(Out::Any(Any::Number(level))) => level == 1.0,
            Some(Out::Any(Any::BigInt(level))) => level == 1,
            Some(Out::Any(Any::String(level))) => level.as_ref() == "1",
            _ => false,
        };
        if !h1 {
            continue;
        }
        if let Some(start) = chapter {
            return Some((start, index as u32 - start));
        }
        if matches!(element.get_attribute(txn, "data-toc-id"), Some(Out::Any(Any::String(heading))) if heading.as_ref() == id)
        {
            chapter = Some(index as u32);
        }
    }
    chapter.map(|start| (start, root.len(txn) - start))
}

fn sorted_ranges(ds: &DeleteSet) -> Vec<(u64, u32, u32)> {
    let mut ds = ds.clone();
    ds.squash();
    let mut ranges: Vec<_> = ds
        .iter()
        .flat_map(|(&client, spans)| spans.iter().map(move |span| (client, span.start, span.end)))
        .collect();
    ranges.sort_unstable();
    ranges
}

pub(super) fn copy_conflicting_chapter(
    conn: &Connection,
    id: &str,
    movement: &Move,
    source_cut: &[u8],
) -> CommandResult<Option<SectionConflict>> {
    let Some(heading) = movement.headings.first() else {
        return Ok(None);
    };
    let doc = crate::worksheets::load(conn, &movement.source)?;
    let root = doc.get_or_insert_xml_fragment("default");
    let Some((start, length)) = chapter_range(&root, &doc.transact(), heading) else {
        return Ok(None);
    };
    let before = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let mut cut_txn = doc.transact_mut();
    root.remove_range(&mut cut_txn, start, length);
    let actual = sorted_ranges(cut_txn.delete_set());
    let expected = Update::decode_v1(source_cut).map_err(db_err)?;
    let expected = expected.delete_set();
    if actual == sorted_ranges(expected) {
        return Ok(None);
    }
    // The same observed version produces the same note and struct IDs.
    // Different concurrent versions remain separately recoverable.
    let mut digest = Sha256::new();
    digest.update(id);
    for (client, start, end) in actual {
        digest.update(client.to_be_bytes());
        digest.update(start.to_be_bytes());
        digest.update(end.to_be_bytes());
    }
    let digest = digest.finalize();
    let module_id = uuid::Builder::from_custom_bytes(digest[..16].try_into().unwrap())
        .into_uuid()
        .to_string();
    // The shared v1 decoder reads Yjs client IDs as unsigned 32-bit values.
    let actor = u32::from_be_bytes(digest[16..20].try_into().unwrap());
    let copy = Doc::with_client_id(u64::from(actor));
    let content = copy.get_or_insert_xml_fragment("default");
    let original = Doc::new();
    original
        .transact_mut()
        .apply_update(Update::decode_v1(&before).map_err(db_err)?)
        .map_err(db_err)?;
    let original_root = original.get_or_insert_xml_fragment("default");
    let read = original.transact();
    let mut copy_txn = copy.transact_mut();
    let mut extras = Vec::new();
    for (index, node) in original_root
        .children(&read)
        .enumerate()
        .skip(start as usize)
        .take(length as usize)
    {
        if matches!(node.id(), yrs::BranchID::Nested(item) if !expected.is_deleted(&item)) {
            extras.push(index as u32);
        }
        copy_xml(&read, node, &content, &mut copy_txn, 0)?;
    }
    drop(read);
    let source_cut = if extras.is_empty() {
        None
    } else {
        let mut cleanup = original.transact_mut();
        for index in extras.into_iter().rev() {
            original_root.remove_range(&mut cleanup, index, 1);
        }
        Some(cleanup.encode_update_v1())
    };
    Ok(Some(SectionConflict {
        module_id,
        content: copy_txn.encode_update_v1(),
        source_cut,
    }))
}

fn copy_xml(
    source: &impl ReadTxn,
    node: XmlOut,
    parent: &impl XmlFragment,
    txn: &mut TransactionMut<'_>,
    depth: usize,
) -> CommandResult<()> {
    if depth > 128 {
        return Err("Chapter recovery content is too deeply nested".into());
    }
    let invalid = || "Unsupported chapter recovery content".to_string();
    match node {
        XmlOut::Element(node) => {
            let copy = parent.push_back(txn, XmlElementPrelim::empty(node.tag().clone()));
            let attrs: std::collections::BTreeMap<_, _> = node.attributes(source).collect();
            for (key, value) in attrs {
                let Out::Any(value) = value else {
                    return Err(invalid());
                };
                copy.insert_attribute(txn, key, value);
            }
            for child in node.children(source) {
                copy_xml(source, child, &copy, txn, depth + 1)?;
            }
        }
        XmlOut::Text(node) => {
            let copy = parent.push_back(txn, XmlTextPrelim::new(""));
            let attrs: std::collections::BTreeMap<_, _> = node.attributes(source).collect();
            for (key, value) in attrs {
                let Out::Any(value) = value else {
                    return Err(invalid());
                };
                copy.insert_attribute(txn, key, value);
            }
            for run in node.diff(source, |_| ()) {
                let Out::Any(Any::String(text)) = run.insert else {
                    return Err(invalid());
                };
                let start = copy.len(txn);
                copy.insert_with_attributes(txn, start, &text, Default::default());
                let len = copy.len(txn) - start;
                let attrs: std::collections::BTreeMap<_, _> = run
                    .attributes
                    .into_iter()
                    .flat_map(|attrs| *attrs)
                    .collect();
                for (key, attr) in attrs {
                    copy.format(txn, start, len, [(key, attr)].into_iter().collect());
                }
            }
        }
        XmlOut::Fragment(_) => return Err(invalid()),
    }
    Ok(())
}
