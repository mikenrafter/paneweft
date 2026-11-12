//! Values with explicit tagged states for everything JSON cannot carry (spec section 4, decision 9; docs/v1-red-contract.md
//! section 2). Display cells format a value; object records keep the tag.
use crate::meter::{json_bytes, json_string_bytes, Meter, RESERVE};
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
    /// List elements and map entries left out because the byte budget ran out.
    pub values: u64,
}

/// Nesting deeper than this is `unsupported`, so a hostile value cannot exhaust the stack.
const MAX_NESTING: u32 = 64;
/// The member name that ends a map cut short by the budget; its value is a `not-captured` marker.
const CUT_KEY: &str = "\u{2026}";

fn marker(meter: Option<&Meter>) -> Json {
    let tag = json!({"$paneweft": "not-captured", "reason": meter.map_or("budget", Meter::reason)});
    if let Some(meter) = meter {
        meter.spend(json_bytes(&tag));
    }
    tag
}

/// Emits `leaf` if it fits in what is left after the reserve, otherwise the marker.
fn emit(leaf: Json, meter: Option<&Meter>, stats: &mut EncodeStats) -> Json {
    let Some(meter) = meter else { return leaf };
    let size = json_bytes(&leaf);
    if size > meter.room().saturating_sub(RESERVE) {
        stats.values += 1;
        return marker(Some(meter));
    }
    meter.spend(size);
    leaf
}

fn exhausted(meter: Option<&Meter>) -> bool { meter.is_some_and(|meter| meter.room() < RESERVE + 2) }

fn is_marker(json: &Json) -> bool { json.get("$paneweft").and_then(Json::as_str) == Some("not-captured") }

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
        self.encode_with(limits, stats, None, 0)
    }

    /// As `encode`, charged against `meter` while it builds (S2): a string is cut to the room left, and a list or map that runs out of room
    /// stops and ends with a `not-captured` marker (a list element, or a map member named `…`); the dropped elements are counted in
    /// `stats.values`. Without a meter nothing is bounded but strings, bytes and nesting.
    pub(crate) fn encode_with(&self, limits: &crate::Limits, stats: &mut EncodeStats, meter: Option<&Meter>, depth: u32) -> Json {
        if depth > MAX_NESTING {
            return emit(json!({"$paneweft": "unsupported", "reason": "nesting"}), meter, stats);
        }
        match self {
            Value::Null => emit(Json::Null, meter, stats),
            Value::Bool(flag) => emit(Json::Bool(*flag), meter, stats),
            Value::Int(number) => emit(encode_int(*number), meter, stats),
            Value::Float(number) => emit(encode_float(*number), meter, stats),
            Value::Str(text) => encode_str_metered(text, limits.string_bytes, stats, meter),
            Value::Bytes(data) => {
                // base64 is 4 bytes per 3; leave 120 bytes for the tag
                let by_room = meter.map_or(u64::MAX, |meter| meter.room().saturating_sub(RESERVE + 120) / 4 * 3);
                emit(encode_bytes(data, limits.string_bytes.min(by_room)), meter, stats)
            }
            Value::List(items) => {
                if exhausted(meter) {
                    stats.values += 1;
                    return marker(meter);
                }
                if let Some(meter) = meter {
                    meter.spend(2);
                }
                let mut out = Vec::new();
                for (index, item) in items.iter().enumerate() {
                    if exhausted(meter) {
                        stats.values += (items.len() - index) as u64;
                        out.push(marker(meter));
                        break;
                    }
                    if let (Some(meter), true) = (meter, index > 0) {
                        meter.spend(1);
                    }
                    let encoded = item.encode_with(limits, stats, meter, depth + 1);
                    let cut = meter.is_some() && is_marker(&encoded);
                    out.push(encoded);
                    if cut {
                        stats.values += (items.len() - index - 1) as u64;
                        break;
                    }
                }
                Json::Array(out)
            }
            Value::Map(entries) => {
                if exhausted(meter) {
                    stats.values += 1;
                    return marker(meter);
                }
                if let Some(meter) = meter {
                    meter.spend(2);
                }
                let mut pairs: Vec<(String, Json)> = Vec::new();
                let mut stopped = false;
                for (index, (key, value)) in entries.iter().enumerate() {
                    if exhausted(meter) {
                        break;
                    }
                    // a key is admitted only if it fits what is left after the reserve (S2); one that does not ends the map
                    if let Some(meter) = meter {
                        let room = meter.room().saturating_sub(RESERVE);
                        let Some(key_bytes) = json_string_bytes(key, room) else { break };
                        let cost = u64::from(index > 0) + key_bytes + 1;
                        if cost > room {
                            break;
                        }
                        meter.spend(cost);
                    }
                    let encoded = value.encode_with(limits, stats, meter, depth + 1);
                    let cut = meter.is_some() && is_marker(&encoded);
                    pairs.push((key.clone(), encoded));
                    if cut {
                        stopped = true;
                        break;
                    }
                }
                if stopped {
                    stats.values += (entries.len() - pairs.len()) as u64;
                } else if pairs.len() < entries.len() {
                    stats.values += (entries.len() - pairs.len()) as u64;
                    let mut cut_key = CUT_KEY.to_string();
                    while pairs.iter().any(|(key, _)| *key == cut_key) {
                        cut_key.push_str(CUT_KEY);
                    }
                    if let Some(meter) = meter {
                        meter.spend(u64::from(!pairs.is_empty()) + json_bytes(&Json::String(cut_key.clone())) + 1);
                    }
                    pairs.push((cut_key, marker(meter)));
                }
                if pairs.iter().any(|(key, _)| key == "$paneweft") {
                    let entries: Vec<Json> = pairs.iter().map(|(key, value)| json!([key, value])).collect();
                    json!({"$paneweft": "map", "entries": entries})
                } else {
                    let mut map = Map::new();
                    for (key, value) in pairs {
                        map.insert(key, value);
                    }
                    Json::Object(map)
                }
            }
            Value::Absent => emit(json!({"$paneweft": "absent"}), meter, stats),
            Value::Redacted(None) => emit(json!({"$paneweft": "redacted"}), meter, stats),
            Value::Redacted(Some(reason)) => emit(json!({"$paneweft": "redacted", "reason": reason}), meter, stats),
            Value::Unsupported(reason) => emit(json!({"$paneweft": "unsupported", "reason": reason}), meter, stats),
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
            Value::List(_) | Value::Map(_) => {
                // a display cell never needs more text than one string may hold, so a huge container is cut here too
                let meter = Meter::new(16 * 1024, 16 * 1024);
                serde_json::to_string(&self.encode_with(&crate::Limits::default(), &mut EncodeStats::default(), Some(&meter), 0)).unwrap_or_default()
            }
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

/// A string cut at the string limit and then, when a meter has less room than that, cut again to the room.
fn encode_str_metered(text: &str, limit: u64, stats: &mut EncodeStats, meter: Option<&Meter>) -> Json {
    let (kept, omitted) = cut_str(text, limit);
    let mut leaf = if omitted == 0 { Json::String(text.to_string()) } else { json!({"$paneweft": "truncated", "text": kept, "keptBytes": kept.len(), "omittedBytes": omitted}) };
    let strings_before = stats.strings;
    if omitted > 0 {
        stats.strings += 1;
    }
    let Some(meter) = meter else { return leaf };
    let allowed = meter.room().saturating_sub(RESERVE);
    if json_bytes(&leaf) > allowed {
        let mut cut = allowed.saturating_sub(90) / 2;
        loop {
            if cut == 0 {
                stats.strings = strings_before;
                stats.values += 1;
                return marker(Some(meter));
            }
            let (text_kept, _) = cut_str(text, limit.min(cut));
            leaf = json!({"$paneweft": "truncated", "text": text_kept, "keptBytes": text_kept.len(), "omittedBytes": text.len() - text_kept.len()});
            if json_bytes(&leaf) <= allowed {
                break;
            }
            cut /= 2;
        }
        if omitted == 0 {
            stats.strings += 1;
        }
    }
    meter.spend(json_bytes(&leaf));
    leaf
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
