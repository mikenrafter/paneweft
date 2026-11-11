//! Collection bounds (spec section 4). Defaults are the numbers in the spec; owner configuration may lower them.
//! `view_rows` is the one number the spec does not give: it bounds the rows (or fields) of one view and defaults to v0's
//! `factItemsPerView` (docs/v1-red-contract.md section 5).
use serde_json::json;

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
    fn default() -> Self {
        Limits {
            depth: 4,
            objects: 1000,
            references: 4000,
            root_bytes: 2 * 1024 * 1024,
            string_bytes: 16 * 1024,
            page_rows: 100,
            collection_bytes: 32 * 1024 * 1024,
            roots: 100,
            view_rows: 10_000,
            view_budget_ms: 100,
        }
    }
}

impl Limits {
    /// The `limits` member of `paneweft.object-graph/1`.
    pub fn to_json(&self) -> serde_json::Value {
        json!({
            "depth": self.depth,
            "objects": self.objects,
            "references": self.references,
            "rootBytes": self.root_bytes,
            "stringBytes": self.string_bytes,
            "pageRows": self.page_rows,
            "collectionBytes": self.collection_bytes,
            "roots": self.roots,
            "viewRows": self.view_rows,
            "viewBudgetMs": self.view_budget_ms,
        })
    }

    /// Applies owner overrides (the camelCase names of the wire `LimitOverrides`); unknown or non-integer members are ignored
    /// because an override can only ever lower a bound, never invent one.
    pub fn with_overrides(mut self, overrides: &serde_json::Value) -> Limits {
        let Some(map) = overrides.as_object() else { return self };
        for (key, value) in map {
            let Some(n) = value.as_u64() else { continue };
            match key.as_str() {
                "depth" => self.depth = n as u32,
                "objects" => self.objects = (n as u32).max(1),
                "references" => self.references = n as u32,
                "rootBytes" => self.root_bytes = n.max(1),
                "stringBytes" => self.string_bytes = n.max(1),
                "pageRows" => self.page_rows = (n as u32).max(1),
                "collectionBytes" => self.collection_bytes = n.max(1),
                "roots" => self.roots = (n as u32).max(1),
                "viewRows" => self.view_rows = (n as u32).max(1),
                "viewBudgetMs" => self.view_budget_ms = n.max(1),
                _ => {}
            }
        }
        self
    }
}
