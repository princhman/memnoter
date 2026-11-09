//! The masks of the two Anki image-occlusion note types, as the editor's
//! masks: shapes in fractions of the image.
use super::html::{tags, Tag};
use super::{AnkiLabel, AnkiMask, MaskShape, Point};
use std::collections::HashMap;

fn unit(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

fn number(tag: &Tag, name: &str) -> Option<f64> {
    let text = tag.attr(name)?.trim();
    let end = text
        .find(|c: char| !(c.is_ascii_digit() || matches!(c, '.' | '-' | '+' | 'e' | 'E')))
        .unwrap_or(text.len());
    text[..end].parse().ok().filter(|n: &f64| n.is_finite())
}

fn rectangle(x: f64, y: f64, width: f64, height: f64) -> Option<MaskShape> {
    let (x, y) = (unit(x), unit(y));
    let (width, height) = (width.min(1.0 - x), height.min(1.0 - y));
    (width > 0.0 && height > 0.0).then_some(MaskShape::Rectangle {
        x,
        y,
        width,
        height,
    })
}

fn ellipse(cx: f64, cy: f64, rx: f64, ry: f64) -> Option<MaskShape> {
    let (cx, cy) = (unit(cx), unit(cy));
    let rx = rx.min(cx).min(1.0 - cx);
    let ry = ry.min(cy).min(1.0 - cy);
    (rx > 0.0 && ry > 0.0).then_some(MaskShape::Ellipse { cx, cy, rx, ry })
}

fn polygon(points: Vec<Point>) -> Option<MaskShape> {
    (points.len() >= 3).then(|| MaskShape::Freehand {
        points: points
            .into_iter()
            .map(|p| Point {
                x: unit(p.x),
                y: unit(p.y),
            })
            .collect(),
    })
}

fn pairs(text: &str) -> Vec<(f64, f64)> {
    let values: Vec<f64> = text
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter_map(|part| part.parse().ok())
        .collect();
    values
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| (pair[0], pair[1]))
        .collect()
}

/// The masks of an Image Occlusion Enhanced "original mask" SVG whose ids are
/// in `wanted`, in `wanted` order. Pixel coordinates divide by the SVG size,
/// which the add-on sets to the image's own.
pub fn enhanced_masks(svg: &str, wanted: &[String]) -> Vec<AnkiMask> {
    let tags = tags(svg);
    let size = tags.iter().find(|tag| tag.name == "svg");
    let (Some(width), Some(height)) = (
        size.and_then(|tag| number(tag, "width"))
            .filter(|w| *w > 0.0),
        size.and_then(|tag| number(tag, "height"))
            .filter(|h| *h > 0.0),
    ) else {
        return Vec::new();
    };
    let mut shapes = HashMap::new();
    for tag in &tags {
        let Some(id) = tag.attr("id") else { continue };
        let n = |name: &str| number(tag, name).unwrap_or(0.0);
        let shape = match tag.name.as_str() {
            "rect" => rectangle(
                n("x") / width,
                n("y") / height,
                n("width") / width,
                n("height") / height,
            ),
            "ellipse" => ellipse(
                n("cx") / width,
                n("cy") / height,
                n("rx") / width,
                n("ry") / height,
            ),
            "polygon" => polygon(
                pairs(tag.attr("points").unwrap_or(""))
                    .into_iter()
                    .map(|(x, y)| Point {
                        x: x / width,
                        y: y / height,
                    })
                    .collect(),
            ),
            _ => None,
        };
        if let Some(shape) = shape {
            shapes.insert(id.to_owned(), shape);
        }
    }
    wanted
        .iter()
        .filter_map(|id| {
            shapes.remove(id).map(|shape| AnkiMask {
                id: id.clone(),
                group: None,
                shape,
            })
        })
        .collect()
}

/// The masks of a built-in Image Occlusion note's `Occlusion` field:
/// `{{c1::image-occlusion:rect:left=.1:top=.2:width=.3:height=.1}}`.
/// Shapes sharing a cloze number are asked together.
pub fn builtin_masks(field: &str) -> Vec<AnkiMask> {
    const MARKER: &str = "::image-occlusion:";
    let mut masks: Vec<AnkiMask> = Vec::new();
    let mut firsts: HashMap<u32, String> = HashMap::new();
    let mut rest = field;
    while let Some(open) = rest.find("{{c") {
        rest = &rest[open + 3..];
        let digits = rest.chars().take_while(char::is_ascii_digit).count();
        let Ok(number_) = rest[..digits].parse::<u32>() else {
            continue;
        };
        let Some(after) = rest[digits..].strip_prefix(MARKER) else {
            continue;
        };
        let Some(close) = after.find("}}") else { break };
        let tokens = shape_parts(&after[..close]);
        let mut parts = tokens.iter().map(String::as_str);
        let kind = parts.next().unwrap_or("");
        let values: HashMap<&str, f64> = parts
            .filter_map(|part| part.split_once('='))
            .filter_map(|(key, value)| value.parse().ok().map(|v| (key, v)))
            .collect();
        let get = |key: &str| values.get(key).copied().unwrap_or(0.0);
        let shape = match kind {
            "rect" => rectangle(get("left"), get("top"), get("width"), get("height")),
            // Verified against Anki shapes/to-cloze.ts and from-cloze.ts:
            // left/top is the bounding-box corner, rx/ry are image fractions.
            "ellipse" => ellipse(
                get("left") + get("rx"),
                get("top") + get("ry"),
                get("rx"),
                get("ry"),
            ),
            "polygon" => {
                let points = tokens
                    .iter()
                    .map(String::as_str)
                    .find_map(|part| part.strip_prefix("points="))
                    .map(pairs)
                    .unwrap_or_default();
                polygon(points.into_iter().map(|(x, y)| Point { x, y }).collect())
            }
            _ => None,
        };
        rest = &after[close + 2..];
        if let Some(shape) = shape {
            let id = format!("c{number_}-{}", masks.len());
            let group = match firsts.get(&number_) {
                Some(first) => Some(first.clone()),
                None => {
                    firsts.insert(number_, id.clone());
                    None
                }
            };
            masks.push(AnkiMask { id, group, shape });
        }
    }
    masks
}

// Anki escapes colons and backslashes in every property value.
fn shape_parts(value: &str) -> Vec<String> {
    let mut parts = vec![String::new()];
    let mut escaped = false;
    for c in value.chars() {
        if escaped {
            parts.last_mut().unwrap().push(c);
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if c == ':' {
            parts.push(String::new());
        } else {
            parts.last_mut().unwrap().push(c);
        }
    }
    if escaped {
        parts.last_mut().unwrap().push('\\');
    }
    parts
}

pub fn builtin_labels(field: &str) -> Vec<AnkiLabel> {
    field
        .split("::image-occlusion:text:")
        .skip(1)
        .filter_map(|part| {
            let end = part.find("}}")?;
            let parts = shape_parts(&part[..end]);
            let values: HashMap<_, _> = parts.iter().filter_map(|p| p.split_once('=')).collect();
            let n = |key, default| {
                values
                    .get(key)
                    .and_then(|v| v.parse::<f64>().ok())
                    .filter(|v| v.is_finite())
                    .unwrap_or(default)
            };
            Some(AnkiLabel {
                text: values.get("text").copied().unwrap_or("").to_owned(),
                x: n("left", 0.0),
                y: n("top", 0.0),
                size: n("fs", 0.05) * n("scale", 1.0),
                color: values.get("fill").copied().unwrap_or("#000000").to_owned(),
                baseline: "top".into(),
            })
        })
        .collect()
}

pub fn enhanced_labels(svg: &str) -> Vec<AnkiLabel> {
    let all = tags(svg);
    let Some(root) = all.iter().find(|t| t.name == "svg") else {
        return vec![];
    };
    let (Some(w), Some(h)) = (number(root, "width"), number(root, "height")) else {
        return vec![];
    };
    if w <= 0.0 || h <= 0.0 {
        return vec![];
    }
    // SVG-Edit writes a title child for the Labels layer.
    let Some(start) = svg.find(">Labels</title>") else {
        return vec![];
    };
    let layer = &svg[start..];
    let layer = &layer[..layer.find("</g>").unwrap_or(layer.len())];
    let mut rest = layer;
    let mut result = vec![];
    while let Some(start) = rest.find("<text") {
        rest = &rest[start..];
        let Some(end) = rest.find("</text>") else {
            break;
        };
        let element = &rest[..end];
        if let Some(tag) = tags(element).first() {
            let content = element.split_once('>').map(|(_, t)| t).unwrap_or("");
            let mut plain = String::new();
            let mut in_tag = false;
            for c in content.chars() {
                match c {
                    '<' => in_tag = true,
                    '>' => in_tag = false,
                    _ if !in_tag => plain.push(c),
                    _ => {}
                }
            }
            result.push(AnkiLabel {
                text: super::html::decode_entities(&plain),
                x: number(tag, "x").unwrap_or(0.0) / w,
                y: number(tag, "y").unwrap_or(0.0) / h,
                size: number(tag, "font-size").unwrap_or(20.0) / h,
                color: tag.attr("fill").unwrap_or("#000000").to_owned(),
                baseline: "alphabetic".into(),
            });
        }
        rest = &rest[end + 7..];
    }
    result
}

pub fn has_rotation(field: &str) -> bool {
    field.split("::image-occlusion:").skip(1).any(|part| {
        let end = part.find("}}").unwrap_or(part.len());
        shape_parts(&part[..end]).iter().any(|value| {
            value
                .strip_prefix("angle=")
                .and_then(|v| v.parse::<f64>().ok())
                .is_some_and(|n| n != 0.0)
        })
    })
}
