//! Values with explicit tagged states for everything JSON cannot carry (spec section 4, decision 9; docs/v1-red-contract.md
//! section 2). Display cells format a value; object records keep the tag.
use crate::bounded::{bytes_of, emit_string, Ledger, CUT_KEY};
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
    /// True once a marker has been written: the cut is marked where it happened, and every container around it ends there without a marker
    /// of its own (the ledger holds back the bytes of one marker, not one per level).
    pub cut: bool,
}

/// Nesting deeper than this is `unsupported`, so a hostile value cannot exhaust the stack.
const MAX_NESTING: u32 = 64;

/// The marker, charged: it may use the reserve. `separator` is the comma that would have preceded the element.
fn marker(ledger: &Ledger, stats: &mut EncodeStats, separator: u64) -> Json {
    let tag = ledger.marker();
    ledger.take_marker(separator + bytes_of(&tag));
    stats.cut = true;
    tag
}

/// Emits `leaf` if it fits, otherwise the marker.
fn leaf(mut json: Json, string_limit: u64, ledger: &Ledger, stats: &mut EncodeStats) -> Json {
    if json["$paneweft"] != "not-captured" {
        if let Some(reason) = json.get("reason").and_then(Json::as_str) {
            let reason = bounded_text(reason, string_limit.min(256), stats);
            json["reason"] = Json::String(reason);
        }
    }
    if ledger.take(bytes_of(&json)) {
        return json;
    }
    stats.values += 1;
    marker(ledger, stats, 0)
}

/// The extra bytes of the map tag over a plain object: `"$paneweft":"map","entries":[` and `]`.
fn map_tag() -> u64 { bytes_of(&json!({"$paneweft": "map", "entries": []})) - 2 }

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
        self.encode_with(limits, stats, &Ledger::new(limits.root_bytes, limits.collection_bytes, 0), 0)
    }

    /// As `encode`, charged to `ledger` while it builds (S2). Every piece is charged by the size of the text it becomes, all or nothing: a leaf
    /// that does not fit becomes a `not-captured` marker (a list element, or a map member named `…`), a container that runs out of room ends with
    /// one marker, and what was dropped is counted in `stats.values`. The caller has just charged something (a name, a frame), so the ledger
    /// holds at least the marker reserve on entry.
    pub(crate) fn encode_with(&self, limits: &crate::Limits, stats: &mut EncodeStats, ledger: &Ledger, depth: u32) -> Json {
        if depth > MAX_NESTING {
            return leaf(json!({"$paneweft": "unsupported", "reason": "nesting"}), limits.string_bytes, ledger, stats);
        }
        match self {
            Value::Null => leaf(Json::Null, limits.string_bytes, ledger, stats),
            Value::Bool(flag) => leaf(Json::Bool(*flag), limits.string_bytes, ledger, stats),
            Value::Int(number) => {
                let encoded = encode_int(*number);
                if encoded.get("decimal").and_then(Json::as_str).is_some_and(|s| s.len() as u64 > limits.string_bytes) {
                    stats.strings += 1; stats.values += 1; marker(ledger, stats, 0)
                } else { leaf(encoded, limits.string_bytes, ledger, stats) }
            },
            Value::Float(number) => leaf(encode_float(*number), limits.string_bytes, ledger, stats),
            Value::Str(text) => encode_str(text, limits.string_bytes, stats, ledger),
            Value::Bytes(data) => encode_bytes(data, limits.string_bytes, stats, ledger),
            Value::List(items) => {
                // a container pays for its two brackets before anything else
                if !ledger.take(2) {
                    stats.values += 1;
                    return marker(ledger, stats, 0);
                }
                let mut out = Vec::new();
                for (index, item) in items.iter().enumerate() {
                    if index > 0 && !ledger.take(1) {
                        stats.values += (items.len() - index) as u64;
                        out.push(marker(ledger, stats, 1));
                        break;
                    }
                    let encoded = item.encode_with(limits, stats, ledger, depth + 1);
                    let cut = stats.cut;
                    out.push(encoded);
                    if cut {
                        stats.values += (items.len() - index - 1) as u64;
                        break;
                    }
                }
                Json::Array(out)
            }
            Value::Map(entries) => {
                if !ledger.take(2) {
                    stats.values += 1;
                    return marker(ledger, stats, 0);
                }
                let mut pairs: Vec<(String, Json)> = Vec::new();
                // what each kept pair cost, so that a pair can be given back when the cut key has no room
                let mut charged: Vec<u64> = Vec::new();
                let mut stopped = false;
                let mut tagged = false;
                for (key, value) in entries {
                    if key.len() as u64 > limits.string_bytes { stats.strings += 1; break; }
                    let before = ledger.used();
                    let separator = u64::from(!pairs.is_empty());
                    // the first `$paneweft` key turns the map into a map tag, which costs more for every entry kept so far
                    let becomes_tagged = !tagged && key == "$paneweft";
                    let extra = if tagged || becomes_tagged { 2 } else { 0 } + if becomes_tagged { map_tag() + 2 * pairs.len() as u64 } else { 0 };
                    let Some(name) = emit_string(key, ledger.spare().saturating_sub(separator + 1 + extra)) else { break };
                    if !ledger.take(separator + name.bytes + 1 + extra) {
                        break;
                    }
                    if becomes_tagged {
                        tagged = true;
                    }
                    let encoded = value.encode_with(limits, stats, ledger, depth + 1);
                    let cut = stats.cut;
                    pairs.push((key.clone(), encoded));
                    charged.push(ledger.used() - before);
                    if cut {
                        stopped = true;
                        break;
                    }
                }
                let left = (entries.len() - pairs.len()) as u64;
                if stopped {
                    stats.values += left;
                } else if left > 0 {
                    stats.values += left;
                    // the member that ends the map; a key already used by a kept member makes the name longer, and a pair is given back until it fits
                    loop {
                        let mut cut_key = CUT_KEY.to_string();
                        while pairs.iter().any(|(key, _)| *key == cut_key) {
                            cut_key.push_str(CUT_KEY);
                        }
                        let tag = ledger.marker();
                        let cost = u64::from(!pairs.is_empty()) + bytes_of(&Json::String(cut_key.clone())) + 1 + bytes_of(&tag) + if tagged { 2 } else { 0 };
                        if cost <= ledger.room() || pairs.is_empty() {
                            ledger.take_marker(cost);
                            stats.cut = true;
                            pairs.push((cut_key, tag));
                            break;
                        }
                        ledger.give(charged.pop().unwrap_or(0));
                        pairs.pop();
                        tagged = pairs.iter().any(|(key, _)| key == "$paneweft");
                        stats.values += 1;
                    }
                }
                if tagged {
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
            Value::Absent => leaf(json!({"$paneweft": "absent"}), limits.string_bytes, ledger, stats),
            Value::Redacted(None) => leaf(json!({"$paneweft": "redacted"}), limits.string_bytes, ledger, stats),
            Value::Redacted(Some(reason)) => leaf(json!({"$paneweft": "redacted", "reason": bounded_text(reason, limits.string_bytes.min(256), stats)}), limits.string_bytes, ledger, stats),
            Value::Unsupported(reason) => leaf(json!({"$paneweft": "unsupported", "reason": bounded_text(reason, limits.string_bytes.min(256), stats)}), limits.string_bytes, ledger, stats),
        }
    }

    /// The display form used for shape examples and list cells.
    pub fn display(&self) -> String {
        bounded_text(&self.display_prefix(16 * 1024), 16 * 1024, &mut EncodeStats::default())
    }
    fn display_prefix(&self, limit: u64) -> String {
        match self {
            Value::Null => "null".to_string(),
            Value::Bool(flag) => flag.to_string(),
            Value::Int(number) => number.to_string(),
            Value::Float(number) => display_float(*number),
            Value::Str(text) => cut_str(text, limit).0.to_string(),
            Value::Bytes(data) => format!("<{} bytes>", data.len()),
            Value::List(_) | Value::Map(_) => {
                // a display cell never needs more text than one string may hold, so a huge container is cut here too
                let ledger = Ledger::new(limit + 128, limit + 128, 0);
                let limits = crate::Limits { string_bytes: limit, ..crate::Limits::default() };
                serde_json::to_string(&self.encode_with(&limits, &mut EncodeStats::default(), &ledger, 0)).unwrap_or_default()
            }
            Value::Absent => "<absent>".to_string(),
            Value::Redacted(None) => "<redacted>".to_string(),
            Value::Redacted(Some(reason)) => format!("<redacted: {}>", cut_str(reason, limit).0),
            Value::Unsupported(reason) => format!("<unsupported: {}>", cut_str(reason, limit).0),
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
            other => Json::String(bounded_text(&other.display_prefix(limits.string_bytes), limits.string_bytes, stats)),
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

fn truncated_tag(text: &str, total: usize) -> Json { json!({"$paneweft": "truncated", "text": text, "keptBytes": text.len(), "omittedBytes": total - text.len()}) }

/// A string cut at the string limit and then, when the ledger has less room than that, cut again to the longest prefix whose tag fits (the size
/// of each candidate is the size of its text, because escaping makes it irregular).
fn encode_str(text: &str, limit: u64, stats: &mut EncodeStats, ledger: &Ledger) -> Json {
    let (kept, omitted) = cut_str(text, limit);
    let whole = if omitted == 0 { Json::String(text.to_string()) } else { truncated_tag(kept, text.len()) };
    if ledger.take(bytes_of(&whole)) {
        if omitted > 0 {
            stats.strings += 1;
        }
        return whole;
    }
    let fits = |at: u64| bytes_of(&truncated_tag(cut_str(text, at).0, text.len())) <= ledger.spare();
    if !fits(0) {
        stats.values += 1;
        return marker(ledger, stats, 0);
    }
    let (mut low, mut high) = (0u64, limit.min(text.len() as u64));
    while low < high {
        let middle = (low + high).div_ceil(2);
        if fits(middle) { low = middle } else { high = middle - 1 }
    }
    let tag = truncated_tag(cut_str(text, low).0, text.len());
    ledger.take(bytes_of(&tag));
    stats.strings += 1;
    tag
}

fn encode_bytes(data: &[u8], limit: u64, stats: &mut EncodeStats, ledger: &Ledger) -> Json {
    let tag = |count: usize| {
        let mut tag = json!({"$paneweft": "bytes", "base64": base64(&data[..count]), "length": data.len()});
        if count < data.len() {
            tag["truncated"] = Json::Bool(true);
        }
        tag
    };
    let mut count = data.len().min((3 * (limit / 4)) as usize);
    if bytes_of(&tag(count)) > ledger.spare() {
        // base64 takes 4 bytes per 3 and nothing in it is escaped, so the room gives the count; the size of the text confirms it
        count = count.min(3 * (ledger.spare().saturating_sub(bytes_of(&tag(0))) / 4) as usize);
        while count > 0 && bytes_of(&tag(count)) > ledger.spare() {
            count = count.saturating_sub(3);
        }
    }
    if count < data.len() { stats.strings += 1; }
    leaf(tag(count), limit, ledger, stats)
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

// CLAIM(S25): scalar display and reason tags share the same pre-serialization cut [tests/emission.rs].
fn bounded_text(text: &str, limit: u64, stats: &mut EncodeStats) -> String {
    let (kept, omitted) = cut_str(text, limit);
    if omitted > 0 { stats.strings += 1; }
    kept.to_string()
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
