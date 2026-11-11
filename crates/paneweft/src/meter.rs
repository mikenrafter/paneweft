//! The byte budget a capture is charged against WHILE it builds its output (S2). The root and the collection budgets are one meter:
//! `room` is what is left of the smaller, `spend` charges bytes of JSON text, `reason` names the budget closer to empty.
use serde_json::Value as Json;
use std::cell::Cell;

/// Bytes kept back so that a container which runs out of room can always end with a marker.
pub(crate) const RESERVE: u64 = 64;

#[derive(Debug)]
pub(crate) struct Meter {
    root_limit: u64,
    total_limit: u64,
    root_used: Cell<u64>,
    total_used: Cell<u64>,
}

impl Meter {
    pub(crate) fn new(root_limit: u64, total_limit: u64) -> Meter {
        Meter { root_limit, total_limit, root_used: Cell::new(0), total_used: Cell::new(0) }
    }

    fn root_room(&self) -> u64 { self.root_limit.saturating_sub(self.root_used.get()) }
    fn total_room(&self) -> u64 { self.total_limit.saturating_sub(self.total_used.get()) }

    pub(crate) fn room(&self) -> u64 { self.root_room().min(self.total_room()) }

    pub(crate) fn spend(&self, bytes: u64) {
        self.root_used.set(self.root_used.get().saturating_add(bytes));
        self.total_used.set(self.total_used.get().saturating_add(bytes));
    }

    pub(crate) fn refund(&self, bytes: u64) {
        self.root_used.set(self.root_used.get().saturating_sub(bytes));
        self.total_used.set(self.total_used.get().saturating_sub(bytes));
    }

    /// A new root starts a fresh root budget.
    pub(crate) fn reset_root(&self) { self.root_used.set(0); }

    pub(crate) fn root_is_closer(&self) -> bool { self.root_room() <= self.total_room() }

    pub(crate) fn reason(&self) -> &'static str {
        if self.root_is_closer() { "root-bytes-limit" } else { "collection-limit" }
    }
}

/// The size in bytes of the JSON text of `json`.
pub(crate) fn json_bytes(json: &Json) -> u64 { json.to_string().len() as u64 }
