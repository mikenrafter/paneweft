//! The one boundary between captured data and capture output (consolidation D1); the same design as packages/paneweft-ts/src/bounded.ts.
//!
//! Every size the SDK charges is the size of a [`Fragment`], and a fragment exists only because [`emit`] serialized it: the bytes are counted
//! on the JSON text that is written, escaping included. Nothing here (or anywhere in the SDK) decides "does it fit" from the length of an
//! input. A [`Ledger`] admits a charge all-or-nothing, so an unchecked spend cannot exist; it holds back the bytes of the one marker that ends
//! a cut container (truncation metadata), and the document's own frame and completeness block are charged before anything else.
//! [`serialize_graph`] is the only function that produces the document text; it measures that text once more and, should the measure ever
//! disagree with the ledger, writes the empty marked graph instead of something over the bound.
use serde_json::{json, Value as Json};
use std::cell::Cell;
use std::rc::Rc;

/// A piece of capture output: JSON text and its exact size in bytes.
#[derive(Debug, Clone)]
pub(crate) struct Fragment {
    pub text: String,
    pub bytes: u64,
}

/// The only serializer: the size of `json` is the size of this text.
pub(crate) fn emit(json: &Json) -> Fragment {
    let text = json.to_string();
    let bytes = text.len() as u64;
    Fragment { text, bytes }
}

/// The size of the JSON text of `json`.
pub(crate) fn bytes_of(json: &Json) -> u64 { emit(json).bytes }

/// The fragment of the string `text` if it is at most `limit` bytes, else `None`. A string longer than `limit` bytes is not looked at: every
/// byte takes at least one byte of JSON text, so it cannot fit (that bounds the work; the size returned is the size of the text emitted).
pub(crate) fn emit_string(text: &str, limit: u64) -> Option<Fragment> {
    if (text.len() as u64).saturating_add(2) > limit {
        return None;
    }
    let fragment = emit(&Json::String(text.to_string()));
    (fragment.bytes <= limit).then_some(fragment)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CutReason {
    RootBytes,
    Collection,
}

impl CutReason {
    pub(crate) fn wire(self) -> &'static str {
        match self {
            CutReason::RootBytes => "root-bytes-limit",
            CutReason::Collection => "collection-limit",
        }
    }
}

/// The wire marker for a value or the rest of a container the byte budget cut.
pub(crate) fn not_captured(reason: &str) -> Json { json!({"$paneweft": "not-captured", "reason": reason}) }

/// The member name that ends a map cut short by the budget; its value is a `not-captured` marker.
pub(crate) const CUT_KEY: &str = "\u{2026}";

/// The most a cut container needs to end: `,"…":` and the longer marker. Held back from ordinary charges, spent only by a marker.
pub(crate) fn marker_reserve() -> u64 {
    1 + bytes_of(&Json::String(CUT_KEY.to_string())) + 1 + bytes_of(&not_captured(CutReason::RootBytes.wire())).max(bytes_of(&not_captured(CutReason::Collection.wire())))
}

/// The bytes a capture may still emit, as the smaller of the root budget and the collection budget.
#[derive(Debug)]
pub(crate) struct Ledger {
    root_limit: u64,
    total_limit: u64,
    root_used: Cell<u64>,
    total_used: Cell<u64>,
    reserve: u64,
}

impl Ledger {
    /// `base` is what the document already holds before any content: its frame and the completeness block it may need.
    pub(crate) fn new(root_limit: u64, total_limit: u64, base: u64) -> Ledger {
        Ledger { root_limit, total_limit, root_used: Cell::new(0), total_used: Cell::new(base), reserve: marker_reserve() }
    }

    fn root_room(&self) -> u64 { self.root_limit.saturating_sub(self.root_used.get()) }
    fn total_room(&self) -> u64 { self.total_limit.saturating_sub(self.total_used.get()) }

    /// Bytes left in the closer budget, the marker reserve included.
    pub(crate) fn room(&self) -> u64 { self.root_room().min(self.total_room()) }

    /// What ordinary content may still use.
    pub(crate) fn spare(&self) -> u64 { self.room().saturating_sub(self.reserve) }

    /// Charges `bytes` if they fit what ordinary content may use; otherwise charges nothing and says so.
    pub(crate) fn take(&self, bytes: u64) -> bool {
        if bytes > self.spare() {
            return false;
        }
        self.root_used.set(self.root_used.get() + bytes);
        self.total_used.set(self.total_used.get() + bytes);
        true
    }

    /// Charges the bytes of a marker, which may use the reserve.
    pub(crate) fn take_marker(&self, bytes: u64) {
        self.root_used.set(self.root_used.get().saturating_add(bytes));
        self.total_used.set(self.total_used.get().saturating_add(bytes));
    }

    pub(crate) fn give(&self, bytes: u64) {
        self.root_used.set(self.root_used.get().saturating_sub(bytes));
        self.total_used.set(self.total_used.get().saturating_sub(bytes));
    }

    /// A new root starts a fresh root budget.
    pub(crate) fn start_root(&self) { self.root_used.set(0); }

    /// Bytes charged to the collection so far; the difference of two readings is what was charged between them.
    pub(crate) fn used(&self) -> u64 { self.total_used.get() }

    pub(crate) fn reason(&self) -> CutReason {
        if self.root_room() <= self.total_room() { CutReason::RootBytes } else { CutReason::Collection }
    }

    /// The marker for the current state.
    pub(crate) fn marker(&self) -> Json { not_captured(self.reason().wire()) }
}

/// What one view has charged so far (its data and its stored pages). The capture settles it against the exact text of the record, or gives
/// all of it back when the view fails.
#[derive(Debug)]
pub(crate) struct Charge {
    ledger: Rc<Ledger>,
    bytes: Cell<u64>,
}

impl Charge {
    pub(crate) fn new(ledger: Rc<Ledger>) -> Charge { Charge { ledger, bytes: Cell::new(0) } }

    pub(crate) fn take(&self, bytes: u64) -> bool {
        if !self.ledger.take(bytes) {
            return false;
        }
        self.bytes.set(self.bytes.get() + bytes);
        true
    }

    pub(crate) fn bytes(&self) -> u64 { self.bytes.get() }
}

/// The most a stored page of `view_id` of `object_id` costs besides its rows: its record in `pages` and its reference in the view, with commas.
pub(crate) fn page_frame(object_id: &str, view_id: &str, index: u64, page_rows: u32) -> u64 {
    let page_id = format!("sha256:{}", "0".repeat(64));
    bytes_of(&json!({"pageId": page_id, "viewId": view_id, "objectId": object_id, "index": index, "rows": []})) + bytes_of(&json!({"index": index, "pageId": page_id, "rowCount": page_rows})) + 2
}

/// The document text and its size.
pub(crate) struct Emission {
    pub text: String,
    /// True when the measure found the document over its bound and the empty marked graph was written instead. Never expected.
    pub emergency: bool,
}

/// Serializes the graph `document` and checks the text against `collection_bytes`. `empty` builds the document written when the ledger and
/// the measure disagree.
pub(crate) fn serialize_graph(document: &Json, collection_bytes: u64, empty: impl FnOnce() -> Json) -> Emission {
    let measured = emit(document);
    if measured.bytes <= collection_bytes {
        return Emission { text: measured.text, emergency: false };
    }
    let fallback = emit(&empty());
    Emission { text: fallback.text, emergency: true }
}
