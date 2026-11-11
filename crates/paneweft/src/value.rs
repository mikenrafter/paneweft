//! Values with explicit tagged states for everything JSON cannot carry (spec section 4, decision 9).

/// A captured value. Display cells format it; object records retain the tag.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Int(i128),
    Float(f64),
    Str(String),
    Bytes(Vec<u8>),
    List(Vec<Value>),
    /// Ordered entries; a key named `$paneweft` is escaped by the map tag.
    Map(Vec<(String, Value)>),
    Absent,
    Redacted(Option<String>),
    Unsupported(String),
}

impl Value {
    pub fn bytes(data: impl Into<Vec<u8>>) -> Value { Value::Bytes(data.into()) }
    pub fn absent() -> Value { Value::Absent }
    pub fn redacted(reason: &str) -> Value { Value::Redacted(Some(reason.to_string())) }
    pub fn map(entries: Vec<(&str, Value)>) -> Value { Value::Map(entries.into_iter().map(|(k, v)| (k.to_string(), v)).collect()) }

    /// The `paneweft.object-graph/1` encoding of this value under `limits` (docs/v1-red-contract.md section 2).
    /// STUB: always `null`.
    pub fn to_json(&self, limits: &crate::Limits) -> serde_json::Value {
        serde_json::Value::Null
    }

    /// The display form used for shape examples and list cells. STUB: empty.
    pub fn display(&self) -> String {
        String::new()
    }
}

impl From<bool> for Value { fn from(v: bool) -> Value { Value::Bool(v) } }
impl From<i32> for Value { fn from(v: i32) -> Value { Value::Int(v as i128) } }
impl From<i64> for Value { fn from(v: i64) -> Value { Value::Int(v as i128) } }
impl From<u32> for Value { fn from(v: u32) -> Value { Value::Int(v as i128) } }
impl From<u64> for Value { fn from(v: u64) -> Value { Value::Int(v as i128) } }
impl From<i128> for Value { fn from(v: i128) -> Value { Value::Int(v) } }
impl From<usize> for Value { fn from(v: usize) -> Value { Value::Int(v as i128) } }
impl From<f64> for Value { fn from(v: f64) -> Value { Value::Float(v) } }
impl From<&str> for Value { fn from(v: &str) -> Value { Value::Str(v.to_string()) } }
impl From<String> for Value { fn from(v: String) -> Value { Value::Str(v) } }
impl<T: Into<Value>> From<Option<T>> for Value {
    fn from(v: Option<T>) -> Value { match v { Some(inner) => inner.into(), None => Value::Null } }
}
