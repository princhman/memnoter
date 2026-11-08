use super::container::{proto_fields, AnkiArchive, Proto};
use super::html::{decode_entities, first_image, percent_decode};
use super::{occlusion, schedule, AnkiCard, AnkiContent, AnkiDeck, AnkiItem, AnkiPackage};
use crate::CommandResult;
use rusqlite::{Connection, OpenFlags};
use std::collections::HashMap;
use std::path::Path;

struct NoteType {
    name: String,
    cloze: bool,
    fields: Vec<String>,
    templates: usize,
}

fn db_err(error: rusqlite::Error) -> String {
    format!("The Anki collection could not be read: {error}")
}

fn table_exists(conn: &Connection, name: &str) -> CommandResult<bool> {
    conn.query_row(
        "select count(*) from sqlite_master where type = 'table' and name = ?1",
        [name],
        |row| row.get::<_, i64>(0),
    )
    .map(|count| count > 0)
    .map_err(db_err)
}

/// Decks and note types of the legacy collection, kept as JSON in `col`.
fn legacy_meta(conn: &Connection) -> CommandResult<(Vec<(i64, String)>, HashMap<i64, NoteType>)> {
    let (decks, models): (String, String) = conn
        .query_row("select decks, models from col", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .map_err(db_err)?;
    let decks: serde_json::Value = serde_json::from_str(&decks).map_err(|e| e.to_string())?;
    let models: serde_json::Value = serde_json::from_str(&models).map_err(|e| e.to_string())?;
    let decks = decks
        .as_object()
        .into_iter()
        .flatten()
        // Filtered decks hold borrowed cards; those count in their home deck.
        .filter(|(_, deck)| deck["dyn"].as_i64().unwrap_or(0) == 0)
        .filter_map(|(key, deck)| Some((key.parse().ok()?, deck["name"].as_str()?.to_owned())))
        .collect();
    let notetypes = models
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(key, model)| {
            let mut fields: Vec<(i64, String)> = model["flds"]
                .as_array()?
                .iter()
                .filter_map(|f| Some((f["ord"].as_i64()?, f["name"].as_str()?.to_owned())))
                .collect();
            fields.sort();
            Some((
                key.parse().ok()?,
                NoteType {
                    name: model["name"].as_str()?.to_owned(),
                    cloze: model["type"].as_i64() == Some(1),
                    fields: fields.into_iter().map(|(_, name)| name).collect(),
                    templates: model["tmpls"].as_array().map_or(0, Vec::len),
                },
            ))
        })
        .collect();
    Ok((decks, notetypes))
}

/// Decks and note types of the latest collection, kept in tables.
fn latest_meta(conn: &Connection) -> CommandResult<(Vec<(i64, String)>, HashMap<i64, NoteType>)> {
    let decks = conn
        .prepare("select id, name from decks")
        .map_err(db_err)?
        .query_map([], |row| {
            Ok((row.get(0)?, row.get::<_, String>(1)?.replace('\x1f', "::")))
        })
        .map_err(db_err)?
        .collect::<Result<_, _>>()
        .map_err(db_err)?;
    let mut notetypes: HashMap<i64, NoteType> = HashMap::new();
    let rows = conn
        .prepare("select id, name, config from notetypes")
        .map_err(db_err)?
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Vec<u8>>(2)?,
            ))
        })
        .map_err(db_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_err)?;
    for (id, name, config) in rows {
        // NotetypeConfig { kind = 1 }: 0 is standard, 1 is cloze.
        let cloze = proto_fields(&config)
            .iter()
            .any(|(field, value)| *field == 1 && matches!(value, Proto::Varint(1)));
        notetypes.insert(
            id,
            NoteType {
                name,
                cloze,
                fields: Vec::new(),
                templates: 0,
            },
        );
    }
    let fields = conn
        .prepare("select ntid, name from fields order by ntid, ord")
        .map_err(db_err)?
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(db_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_err)?;
    for (ntid, name) in fields {
        if let Some(notetype) = notetypes.get_mut(&ntid) {
            notetype.fields.push(name);
        }
    }
    let templates = conn
        .prepare("select ntid, count(*) from templates group by ntid")
        .map_err(db_err)?
        .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))
        .map_err(db_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_err)?;
    for (ntid, count) in templates {
        if let Some(notetype) = notetypes.get_mut(&ntid) {
            notetype.templates = count as usize;
        }
    }
    Ok((decks, notetypes))
}

fn field_index(notetype: &NoteType, name: &str) -> Option<usize> {
    notetype.fields.iter().position(|field| field == name)
}

/// An Image Occlusion Enhanced note's id is `<set>-<mode>-<number>`; every
/// note of one set masks one image.
fn enhanced_set(id: &str) -> &str {
    let mut parts = id.rsplitn(3, '-');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(_), Some(_), Some(set)) => set,
        _ => id,
    }
}

/// A media reference as the media list names it.
fn media_name(archive: &AnkiArchive, reference: &str) -> String {
    let decoded = decode_entities(reference);
    if archive.has_media(&decoded) {
        return decoded;
    }
    let percent = percent_decode(&decoded);
    if archive.has_media(&percent) {
        percent
    } else {
        decoded
    }
}

struct NoteCard {
    did: i64,
    card: AnkiCard,
}

struct EnhancedSet {
    item: usize,
    svg: Option<String>,
    wanted: Vec<String>,
}

pub fn read(path: &Path, archive: &AnkiArchive) -> CommandResult<AnkiPackage> {
    let conn =
        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(db_err)?;
    let (deck_rows, notetypes) = if table_exists(&conn, "notetypes")? {
        latest_meta(&conn)?
    } else {
        legacy_meta(&conn)?
    };
    let (raw_cards, mut reviews, created) = schedule::read(&conn)?;
    let mut cards: HashMap<i64, Vec<NoteCard>> = HashMap::new();
    let mut card_counts: HashMap<i64, usize> = HashMap::new();
    for raw in raw_cards {
        let (nid, did) = (raw.nid, raw.did);
        *card_counts.entry(did).or_default() += 1;
        cards.entry(nid).or_default().push(NoteCard {
            did,
            card: raw.into_card(created, &mut reviews),
        });
    }

    let mut warnings = Vec::new();
    let mut unsupported: HashMap<String, usize> = HashMap::new();
    let mut items: Vec<AnkiItem> = Vec::new();
    let mut sets: HashMap<(i64, String, String), EnhancedSet> = HashMap::new();
    let notes = conn
        .prepare("select id, mid, flds from notes order by id")
        .map_err(db_err)?
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(db_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_err)?;
    for (note_id, mid, flds) in notes {
        let (Some(notetype), Some(note_cards)) = (notetypes.get(&mid), cards.get(&note_id)) else {
            continue;
        };
        let deck_id = note_cards[0].did;
        let fields: Vec<&str> = flds.split('\x1f').collect();
        let field = |name: &str| {
            field_index(notetype, name)
                .and_then(|i| fields.get(i).copied())
                .unwrap_or("")
        };
        let nth = |i: usize| fields.get(i).copied().unwrap_or("").to_owned();
        let item = |content| AnkiItem {
            note_id,
            deck_id,
            notetype: notetype.name.clone(),
            cards: note_cards.iter().map(|c| c.card.clone()).collect(),
            content,
        };

        if notetype.cloze
            && ((field_index(notetype, "Occlusion").is_some()
                && field_index(notetype, "Image").is_some())
                || (notetype.fields.len() == 5 && nth(0).contains("::image-occlusion:")))
        {
            let occlusion_field = if field_index(notetype, "Occlusion").is_some() {
                field("Occlusion").to_owned()
            } else {
                nth(0)
            };
            let image_field = if field_index(notetype, "Image").is_some() {
                field("Image").to_owned()
            } else {
                nth(1)
            };
            if occlusion::has_rotation(&occlusion_field) {
                warnings.push("Rotated Anki occlusions were imported without rotation.".into());
            }
            let masks = occlusion::builtin_masks(&occlusion_field);
            let image = first_image(&image_field).map(|src| media_name(archive, &src));
            let mut built = item(AnkiContent::Unsupported {
                notetype: notetype.name.clone(),
            });
            // Card N asks the shapes numbered N together; the first owns it.
            for card in &mut built.cards {
                let prefix = format!("c{}-", card.ord + 1);
                card.mask = masks
                    .iter()
                    .find(|mask| mask.id.starts_with(&prefix))
                    .map(|mask| mask.id.clone());
            }
            built.cards.retain(|card| card.mask.is_some());
            built.content = match image {
                Some(image) if !masks.is_empty() => AnkiContent::Occlusion {
                    image,
                    masks,
                    labels: occlusion::builtin_labels(&occlusion_field),
                    header: field("Header").to_owned(),
                    extra: field("Back Extra").to_owned(),
                },
                _ => {
                    *unsupported.entry(notetype.name.clone()).or_default() += 1;
                    AnkiContent::Unsupported {
                        notetype: notetype.name.clone(),
                    }
                }
            };
            items.push(built);
        } else if field_index(notetype, "Original Mask").is_some()
            && field_index(notetype, "Question Mask").is_some()
        {
            let id = field("ID (hidden)").to_owned();
            let image = first_image(field("Image")).map(|src| media_name(archive, &src));
            let key = (
                deck_id,
                enhanced_set(&id).to_owned(),
                image.clone().unwrap_or_default(),
            );
            // Each note of an Enhanced set is one mask's card.
            let masked = |mut card: AnkiCard, id: &str| {
                card.mask = Some(id.to_owned());
                card
            };
            if let Some(set) = sets.get_mut(&key) {
                let card = masked(note_cards[0].card.clone(), &id);
                items[set.item].cards.push(card);
                set.wanted.push(id);
                continue;
            }
            sets.insert(
                key,
                EnhancedSet {
                    item: items.len(),
                    svg: first_image(field("Original Mask")).map(|src| media_name(archive, &src)),
                    wanted: vec![id.clone()],
                },
            );
            let mut first = item(match image {
                Some(image) => AnkiContent::Occlusion {
                    image,
                    masks: Vec::new(),
                    labels: Vec::new(),
                    header: field("Header").to_owned(),
                    extra: field("Remarks").to_owned(),
                },
                None => AnkiContent::Unsupported {
                    notetype: notetype.name.clone(),
                },
            });
            first.cards = vec![masked(note_cards[0].card.clone(), &id)];
            items.push(first);
        } else if notetype.cloze {
            items.push(item(AnkiContent::Cloze {
                text: nth(0),
                extra: nth(1),
            }));
        } else if notetype.fields.len() >= 2 {
            items.push(item(AnkiContent::Basic {
                front: nth(0),
                back: nth(1),
                extra: field("Notes").to_owned(),
                // "Basic (and reversed card)" and its optional variant.
                reversed: notetype.templates == 2 && note_cards.iter().any(|c| c.card.ord == 1),
            }));
        } else {
            *unsupported.entry(notetype.name.clone()).or_default() += 1;
            items.push(item(AnkiContent::Unsupported {
                notetype: notetype.name.clone(),
            }));
        }
    }

    for set in sets.into_values() {
        let mut labels = Vec::new();
        let masks = set
            .svg
            .and_then(|name| archive.read_media(&name).ok())
            .map(|svg| {
                let svg = String::from_utf8_lossy(&svg);
                labels = occlusion::enhanced_labels(&svg);
                occlusion::enhanced_masks(&svg, &set.wanted)
            })
            .unwrap_or_default();
        let item = &mut items[set.item];
        if masks.is_empty() {
            *unsupported.entry(item.notetype.clone()).or_default() += 1;
            item.content = AnkiContent::Unsupported {
                notetype: item.notetype.clone(),
            };
        } else if let AnkiContent::Occlusion {
            masks: slot,
            labels: label_slot,
            ..
        } = &mut item.content
        {
            // A mask without a note has no card, and so no schedule.
            item.cards.retain(|card| {
                masks
                    .iter()
                    .any(|mask| Some(&mask.id) == card.mask.as_ref())
            });
            *slot = masks;
            *label_slot = labels;
        }
    }
    items.retain(|item| !matches!(item.content, AnkiContent::Occlusion { ref masks, .. } if masks.is_empty()));
    items.sort_by_key(|item| item.note_id);
    let mut unsupported: Vec<_> = unsupported.into_iter().collect();
    unsupported.sort();
    for (name, count) in unsupported {
        warnings.push(format!(
            "{count} {} of type {name} can't be imported.",
            if count == 1 { "note" } else { "notes" }
        ));
    }

    let mut decks: Vec<AnkiDeck> = deck_rows
        .into_iter()
        .map(|(id, name)| AnkiDeck {
            id,
            name,
            card_count: card_counts.get(&id).copied().unwrap_or(0),
        })
        .collect();
    decks.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(AnkiPackage {
        decks,
        items,
        media: Vec::new(),
        warnings,
    })
}
