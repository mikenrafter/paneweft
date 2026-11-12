//! Canonical JSON, sha256 and RFC 3339 helpers shared by the encoding layer. Canonical = object keys sorted by UTF-16 code unit at
//! every level, arrays in order, no whitespace: the same text the host's `canonicalJson` produces, so hashes agree across languages.
use serde_json::Value as Json;
use sha2::{Digest, Sha256};

fn compare_code_units(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn write_canonical(value: &Json, out: &mut String) {
    match value {
        Json::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| compare_code_units(a, b));
            out.push('{');
            for (index, key) in keys.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).expect("string serializes"));
                out.push(':');
                write_canonical(&map[*key], out);
            }
            out.push('}');
        }
        Json::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        Json::Number(number) => {
            let number = number.as_f64().expect("JSON numbers are finite IEEE 754 values");
            if number == 0.0 { out.push('0'); }
            else { out.push_str(ryu_js::Buffer::new().format(number)); }
        }
        other => out.push_str(&serde_json::to_string(other).expect("scalar serializes")),
    }
}

pub fn canonical(value: &Json) -> String {
    let mut out = String::new();
    write_canonical(value, &mut out);
    out
}

pub fn sha256_hex(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// `2026-11-11T12:00:00.123Z` for the system clock (civil-from-days, no calendar dependency).
pub fn now_rfc3339() -> String {
    let elapsed = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let seconds = elapsed.as_secs() as i64;
    let millis = elapsed.subsec_millis();
    let days = seconds.div_euclid(86_400);
    let secs_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z", secs_of_day / 3600, (secs_of_day % 3600) / 60, secs_of_day % 60)
}

/// Howard Hinnant's days-to-civil algorithm.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    // why: a wrong epoch conversion would stamp every artifact with a plausible but false time. Known instants, computed by hand.
    #[test]
    fn civil_dates_match_known_instants() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_038), (2024, 11, 11));
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
    }

    // why: canonical text is what the content hash covers; two key orders must give one text, and the order is by code unit.
    #[test]
    fn canonical_sorts_keys_at_every_level() {
        let value = serde_json::json!({"b": {"y": 1, "x": [ {"d": 1, "c": 2} ]}, "a": null});
        assert_eq!(canonical(&value), r#"{"a":null,"b":{"x":[{"c":2,"d":1}],"y":1}}"#);
    }
}

#[cfg(test)]
mod jcs_fixtures {
    use super::*;
    // WHY CLAIM(S28): independent literal encodings/hashes shared with the host, not a writer/reader round trip.
    #[test]
    fn s28_literal_cross_language_hashes() {
        let fixtures: Json = serde_json::from_str(include_str!("../../../fixtures/v1/canonical-hashes.json")).unwrap();
        for fixture in fixtures.as_array().unwrap() {
            let value: Json = serde_json::from_str(fixture["source"].as_str().unwrap()).unwrap();
            assert_eq!(canonical(&value), fixture["canonical"].as_str().unwrap(), "{}", fixture["name"]);
            assert_eq!(sha256_hex(&canonical(&value)), fixture["sha256"].as_str().unwrap());
        }
    }
}
