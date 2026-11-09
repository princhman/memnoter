//! Just enough markup scanning for note fields and SVG masks: opening tags
//! and their attributes. Anything richer is the converter's job.

pub struct Tag {
    pub name: String,
    pub attrs: Vec<(String, String)>,
}

impl Tag {
    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

pub fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        rest = &rest[start..];
        let decoded = rest.find(';').filter(|&end| end <= 10).and_then(|end| {
            let entity = &rest[1..end];
            let value = match entity {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "nbsp" => Some('\u{a0}'),
                _ => entity
                    .strip_prefix('#')
                    .and_then(|number| match number.strip_prefix(['x', 'X']) {
                        Some(hex) => u32::from_str_radix(hex, 16).ok(),
                        None => number.parse().ok(),
                    })
                    .and_then(char::from_u32),
            };
            value.map(|c| (c, end))
        });
        match decoded {
            Some((c, end)) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

pub fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((high * 16 + low) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| text.to_owned())
}

/// Every opening (or self-closing) tag, in document order.
pub fn tags(markup: &str) -> Vec<Tag> {
    let mut tags = Vec::new();
    let mut rest = markup;
    while let Some(start) = rest.find('<') {
        rest = &rest[start + 1..];
        if rest.starts_with("!--") {
            rest = rest.find("-->").map_or("", |end| &rest[end + 3..]);
            continue;
        }
        let Some(end) = tag_end(rest) else { break };
        let body = rest[..end].trim_end_matches('/');
        rest = &rest[end + 1..];
        if body.starts_with(['/', '!', '?']) {
            continue;
        }
        let name_end = body.find(|c: char| c.is_whitespace()).unwrap_or(body.len());
        tags.push(Tag {
            name: body[..name_end].to_ascii_lowercase(),
            attrs: attributes(&body[name_end..]),
        });
    }
    tags
}

/// The index of the `>` closing a tag, skipping quoted attribute values.
fn tag_end(text: &str) -> Option<usize> {
    let mut quote = None;
    for (index, c) in text.char_indices() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (None, '"' | '\'') => quote = Some(c),
            (None, '>') => return Some(index),
            _ => {}
        }
    }
    None
}

fn attributes(mut text: &str) -> Vec<(String, String)> {
    let mut attrs = Vec::new();
    loop {
        text = text.trim_start();
        let name_end = text
            .find(|c: char| c.is_whitespace() || c == '=')
            .unwrap_or(text.len());
        if name_end == 0 {
            // A stray `=` or end of input.
            if text.is_empty() {
                break;
            }
            text = &text[1..];
            continue;
        }
        let name = text[..name_end].to_ascii_lowercase();
        text = text[name_end..].trim_start();
        let Some(after) = text.strip_prefix('=') else {
            attrs.push((name, String::new()));
            continue;
        };
        text = after.trim_start();
        let value = match text.chars().next() {
            Some(q @ ('"' | '\'')) => {
                let inner = &text[1..];
                let end = inner.find(q).unwrap_or(inner.len());
                text = inner.get(end + 1..).unwrap_or("");
                &inner[..end]
            }
            _ => {
                let end = text.find(char::is_whitespace).unwrap_or(text.len());
                let value = &text[..end];
                text = &text[end..];
                value
            }
        };
        attrs.push((name, decode_entities(value)));
    }
    attrs
}

/// The `src` of the first image in a field.
pub fn first_image(field: &str) -> Option<String> {
    tags(field)
        .into_iter()
        .find(|tag| tag.name == "img")
        .and_then(|tag| tag.attr("src").map(str::to_owned))
}
