//! Values with explicit tagged states for everything JSON cannot carry (spec section 4, decision 9; docs/v1-red-contract.md
//! section 2). Display cells format a value; object records keep the tag.
use serde_json::{json, Map, Number, Value as Json};

/// 2^53 - 1: the largest integer a JavaScript number holds exactly.
const MAX_SAFE: i128 = 9_007_199_254_740_991;

fn is_safe(number: i128) -> bool {
    number.unsigned_abs() <= MAX_SAFE as u128
}

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

/// What encoding a value had to give up, so builders can name the omission instead of hiding it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct EncodeStats {
    /// Strings cut at the string limit.
    pub strings: u64,
}

impl Value {
    pub fn bytes(data: impl Into<Vec<u8>>) -> Value { Value::Bytes(data.into()) }
    pub fn absent() -> Value { Value::Absent }
    pub fn redacted(reason: &str) -> Value { Value::Redacted(Some(reason.to_string())) }
    pub fn map(entries: Vec<(&str, Value)>) -> Value { Value::Map(entries.into_iter().map(|(k, v)| (k.to_string(), v)).collect()) }

    /// The `paneweft.object-graph/1` encoding of this value under `limits`.
    pub fn to_json(&self, limits: &crate::Limits) -> Json {
        self.encode(limits, &mut EncodeStats::default())
    }

    pub(crate) fn encode(&self, limits: &crate::Limits, stats: &mut EncodeStats) -> Json {
        match self {
            Value::Null => Json::Null,
            Value::Bool(flag) => Json::Bool(*flag),
            Value::Int(number) => encode_int(*number),
            Value::Float(number) => encode_float(*number),
            Value::Str(text) => encode_str(text, limits.string_bytes, stats),
            Value::Bytes(data) => encode_bytes(data, limits.string_bytes),
            Value::List(items) => Json::Array(items.iter().map(|item| item.encode(limits, stats)).collect()),
            Value::Map(entries) => {
                if entries.iter().any(|(key, _)| key == "$paneweft") {
                    let pairs: Vec<Json> = entries.iter().map(|(key, value)| json!([key, value.encode(limits, stats)])).collect();
                    json!({"$paneweft": "map", "entries": pairs})
                } else {
                    let mut map = Map::new();
                    for (key, value) in entries {
                        map.insert(key.clone(), value.encode(limits, stats));
                    }
                    Json::Object(map)
                }
            }
            Value::Absent => json!({"$paneweft": "absent"}),
            Value::Redacted(None) => json!({"$paneweft": "redacted"}),
            Value::Redacted(Some(reason)) => json!({"$paneweft": "redacted", "reason": reason}),
            Value::Unsupported(reason) => json!({"$paneweft": "unsupported", "reason": reason}),
        }
    }

    /// The display form used for shape examples and list cells.
    pub fn display(&self) -> String {
        match self {
            Value::Null => "null".to_string(),
            Value::Bool(flag) => flag.to_string(),
            Value::Int(number) => number.to_string(),
            Value::Float(number) => display_float(*number),
            Value::Str(text) => text.clone(),
            Value::Bytes(data) => format!("<{} bytes>", data.len()),
            Value::List(_) | Value::Map(_) => serde_json::to_string(&self.to_json(&crate::Limits::default())).unwrap_or_default(),
            Value::Absent => "<absent>".to_string(),
            Value::Redacted(None) => "<redacted>".to_string(),
            Value::Redacted(Some(reason)) => format!("<redacted: {reason}>"),
            Value::Unsupported(reason) => format!("<unsupported: {reason}>"),
        }
    }

    /// The JSON-scalar form of a cell or a shape example (Scalar: string, number, boolean, null): plain scalars stay typed, every
    /// other state shows its display text. A string over the limit is cut at a code point and counted.
    pub(crate) fn scalar(&self, limits: &crate::Limits, stats: &mut EncodeStats) -> Json {
        match self {
            Value::Null => Json::Null,
            Value::Bool(flag) => Json::Bool(*flag),
            Value::Int(number) if is_safe(*number) => encode_int(*number),
            Value::Float(number) if number.is_finite() && !(*number == 0.0 && number.is_sign_negative()) => encode_float(*number),
            Value::Str(text) => {
                let (kept, omitted) = cut_str(text, limits.string_bytes);
                if omitted > 0 {
                    stats.strings += 1;
                }
                Json::String(kept.to_string())
            }
            other => Json::String(other.display()),
        }
    }

    /// The shape `type` of a leaf.
    pub(crate) fn type_name(&self) -> &'static str {
        match self {
            Value::Null => "null",
            Value::Bool(_) => "boolean",
            Value::Int(number) if is_safe(*number) => "number",
            Value::Int(_) => "bigint",
            Value::Float(_) => "number",
            Value::Str(_) => "string",
            Value::Bytes(_) => "bytes",
            Value::List(_) => "array",
            Value::Map(_) => "object",
            Value::Absent => "absent",
            Value::Redacted(_) => "redacted",
            Value::Unsupported(_) => "unsupported",
        }
    }
}

fn encode_int(number: i128) -> Json {
    if is_safe(number) {
        Json::Number(Number::from(number as i64))
    } else {
        json!({"$paneweft": "bigint", "decimal": number.to_string()})
    }
}

fn encode_float(number: f64) -> Json {
    if number.is_nan() {
        return json!({"$paneweft": "float", "value": "NaN"});
    }
    if number.is_infinite() {
        return json!({"$paneweft": "float", "value": if number > 0.0 { "Infinity" } else { "-Infinity" }});
    }
    if number == 0.0 && number.is_sign_negative() {
        return json!({"$paneweft": "float", "value": "-0"});
    }
    // An integral finite float is the same plain number in both SDKs (3.0 -> 3), because JavaScript cannot tell them apart.
    if number.fract() == 0.0 && number.abs() <= MAX_SAFE as f64 {
        return Json::Number(Number::from(number as i64));
    }
    Number::from_f64(number).map(Json::Number).unwrap_or(Json::Null)
}

fn display_float(number: f64) -> String {
    if number.is_nan() {
        "NaN".to_string()
    } else if number.is_infinite() {
        if number > 0.0 { "Infinity".to_string() } else { "-Infinity".to_string() }
    } else if number == 0.0 && number.is_sign_negative() {
        "-0".to_string()
    } else {
        match encode_float(number) {
            Json::Number(n) => n.to_string(),
            _ => number.to_string(),
        }
    }
}

/// `(kept prefix, omitted byte count)`; the cut never splits a UTF-8 code point.
pub(crate) fn cut_str(text: &str, limit: u64) -> (&str, u64) {
    let limit = limit as usize;
    if text.len() <= limit {
        return (text, 0);
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (&text[..end], (text.len() - end) as u64)
}

fn encode_str(text: &str, limit: u64, stats: &mut EncodeStats) -> Json {
    let (kept, omitted) = cut_str(text, limit);
    if omitted == 0 {
        return Json::String(text.to_string());
    }
    stats.strings += 1;
    json!({"$paneweft": "truncated", "text": kept, "keptBytes": kept.len(), "omittedBytes": omitted})
}

fn encode_bytes(data: &[u8], limit: u64) -> Json {
    let kept = &data[..data.len().min(limit as usize)];
    let mut tag = json!({"$paneweft": "bytes", "base64": base64(kept), "length": data.len()});
    if kept.len() < data.len() {
        tag["truncated"] = Json::Bool(true);
    }
    tag
}

/// Standard base64 with padding (RFC 4648), written out to keep the SDK free of an encoding dependency.
pub(crate) fn base64(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { ALPHABET[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHABET[n as usize & 63] as char } else { '=' });
    }
    out
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

#[cfg(test)]
mod tests {
    use super::*;

    // why: base64 is hand-written; RFC 4648 section 10 vectors pin every padding case.
    #[test]
    fn base64_matches_rfc_4648_vectors() {
        for (input, expected) in [("", ""), ("f", "Zg=="), ("fo", "Zm8="), ("foo", "Zm9v"), ("foob", "Zm9vYg=="), ("fooba", "Zm9vYmE="), ("foobar", "Zm9vYmFy")] {
            assert_eq!(base64(input.as_bytes()), expected);
        }
    }
}
