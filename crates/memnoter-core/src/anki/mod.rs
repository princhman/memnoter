//! Reads Anki `.apkg` packages. Nothing here touches Memnoter storage: the
//! host gets a plain description of the decks and notes (the contract the
//! converter in shared-ui consumes) and fetches media files by name later.
//!
//! Two containers exist. The legacy one holds `collection.anki2`/`.anki21`
//! (SQLite, decks and note types as JSON in the `col` row) and a JSON media
//! map. The latest one holds a zstd-compressed `collection.anki21b` (decks
//! and note types in tables), a zstd-compressed protobuf media list, and
//! zstd-compressed media files.

mod collection;
mod container;
mod html;
mod occlusion;
mod schedule;
mod sessions;
pub use sessions::{OpenedPackage, Sessions};

use crate::CommandResult;
pub use container::AnkiArchive;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnkiDeck {
    pub id: i64,
    /// The full path, levels joined by `::`.
    pub name: String,
    /// Cards that sit directly in this deck, not in its subdecks.
    pub card_count: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "shape", rename_all = "lowercase")]
pub enum MaskShape {
    Rectangle {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    },
    Ellipse {
        cx: f64,
        cy: f64,
        rx: f64,
        ry: f64,
    },
    Freehand {
        points: Vec<Point>,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// Coordinates are fractions of the image, as in the editor's masks.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AnkiMask {
    pub id: String,
    /// The id of the mask whose card this one joins.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(flatten)]
    pub shape: MaskShape,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum CardKind {
    New,
    Learning,
    Review,
    Relearning,
}

/// One answer in the review log: when (epoch ms) and which button, 1 to 4.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnkiReview {
    pub time: i64,
    pub rating: i64,
}

/// An Anki card's schedule. Times are epoch milliseconds.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnkiCard {
    /// The template number: 0 for the front card, 1 for the reverse, and the
    /// cloze number minus one for clozes.
    pub ord: i64,
    /// For occlusion notes, the mask whose card this is.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mask: Option<String>,
    pub kind: CardKind,
    pub suspended: bool,
    /// When the card is next due; absent for new cards.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due: Option<i64>,
    pub interval_days: f64,
    /// The ease factor as a multiplier, such as 2.5.
    pub ease: f64,
    pub reps: i64,
    pub lapses: i64,
    pub reviews: Vec<AnkiReview>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AnkiLabel {
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub size: f64,
    pub color: String,
    /// SVG uses a baseline; Anki built-in text uses the top of its box.
    pub baseline: String,
}

/// Field values are Anki's HTML, untouched.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AnkiContent {
    #[serde(rename_all = "camelCase")]
    Basic {
        front: String,
        back: String,
        extra: String,
        reversed: bool,
    },
    #[serde(rename_all = "camelCase")]
    Cloze { text: String, extra: String },
    /// One image with all its masks; both occlusion note types produce this.
    #[serde(rename_all = "camelCase")]
    Occlusion {
        image: String,
        masks: Vec<AnkiMask>,
        labels: Vec<AnkiLabel>,
        header: String,
        extra: String,
    },
    #[serde(rename_all = "camelCase")]
    Unsupported { notetype: String },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnkiItem {
    pub note_id: i64,
    /// The deck of the note's first card.
    pub deck_id: i64,
    pub notetype: String,
    /// The note's cards with their schedules.
    pub cards: Vec<AnkiCard>,
    #[serde(flatten)]
    pub content: AnkiContent,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnkiPackage {
    pub decks: Vec<AnkiDeck>,
    pub items: Vec<AnkiItem>,
    /// The names of the package's media files.
    pub media: Vec<String>,
    pub warnings: Vec<String>,
}

pub fn read_package(archive: &AnkiArchive) -> CommandResult<AnkiPackage> {
    let collection = archive.collection()?;
    let mut package = collection::read(collection.path(), archive)?;
    package.media = archive.media_names();
    Ok(package)
}

#[cfg(test)]
mod tests;
