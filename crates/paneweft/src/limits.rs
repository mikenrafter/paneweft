//! Collection bounds (spec section 4). Defaults are the numbers in the spec; owner configuration may lower them.

/// Hard limits applied while building, never after constructing an unbounded intermediate value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub depth: u32,
    pub objects: u32,
    pub references: u32,
    pub root_bytes: u64,
    pub string_bytes: u64,
    pub page_rows: u32,
    pub collection_bytes: u64,
    pub roots: u32,
    pub view_rows: u32,
    pub view_budget_ms: u64,
}

impl Default for Limits {
    /// STUB: all zero. Green returns depth 4, objects 1000, references 4000, root_bytes 2 MiB, string_bytes 16 KiB,
    /// page_rows 100, collection_bytes 32 MiB, roots 100, view_rows 10_000 (v0 `factItemsPerView`), view_budget_ms 100.
    fn default() -> Self {
        Limits { depth: 0, objects: 0, references: 0, root_bytes: 0, string_bytes: 0, page_rows: 0, collection_bytes: 0, roots: 0, view_rows: 0, view_budget_ms: 0 }
    }
}
