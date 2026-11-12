//! Tagged non-JSON values (spec decision 9, amendment S11) and the default limits (spec section 4).
//! Every expectation comes from fixtures/v1/values.json, which was reviewed by hand against docs/v1-red-contract.md section 2 and is
//! shared with the TypeScript SDK test, so the two encoders are held to the same literal bytes.
mod support;
use paneweft::{Limits, Value};
use support::{limits_from, load, value_from_spec};

// why: both SDKs must encode the same value to the same tagged JSON, or a cross-language comparison would diverge silently.
// A case-by-case loop would stay green if the fixture list shrank, so the required names are pinned first.
// proves: CLAIM(S11-tagged-values) CLAIM(IV9)
#[test]
fn every_fixture_case_encodes_to_its_literal_json() {
    let fixture = load("values.json");
    let cases = fixture["cases"].as_array().expect("cases");
    let names: Vec<&str> = cases.iter().map(|c| c["name"].as_str().unwrap()).collect();
    for required in ["first-unsafe-int", "u64-max", "nan", "negative-zero", "bytes", "absent", "redacted-with-reason", "string-truncated-never-splits-a-code-point", "map-with-the-reserved-key-is-wrapped"] {
        assert!(names.contains(&required), "fixture lost the case {required}");
    }
    let mut failures = Vec::new();
    for case in cases {
        let limits = limits_from(case.get("limits").unwrap_or(&fixture["limits"]));
        let actual = value_from_spec(&case["input"]).to_json(&limits);
        if actual != case["expected"] {
            failures.push(format!("{}: expected {} got {}", case["name"], case["expected"], actual));
        }
    }
    assert!(failures.is_empty(), "{} of {} cases differ:\n{}", failures.len(), cases.len(), failures.join("\n"));
}

// why: a lossy numeric conversion is a silent data error. i64/u64 outside the JavaScript safe range must become typed decimal strings,
// and the boundary is exactly 2^53 - 1 (an off-by-one here corrupts ids).
// proves: CLAIM(S11-tagged-values)
#[test]
fn integers_beyond_the_safe_range_never_become_json_numbers() {
    let limits = limits_from(&serde_json::Value::Null);
    assert_eq!(Value::from(9_007_199_254_740_991_i64).to_json(&limits), serde_json::json!(9007199254740991_i64));
    assert_eq!(Value::from(9_007_199_254_740_992_i64).to_json(&limits), serde_json::json!({"$paneweft": "bigint", "decimal": "9007199254740992"}));
    assert_eq!(Value::from(u64::MAX).to_json(&limits), serde_json::json!({"$paneweft": "bigint", "decimal": "18446744073709551615"}));
    assert_eq!(Value::from(i64::MIN).to_json(&limits), serde_json::json!({"$paneweft": "bigint", "decimal": "-9223372036854775808"}));
}

// why: JSON has no integral/fractional distinction in JavaScript, so a finite float with an integral value must encode as the same
// plain number in both languages (3.0 -> 3), or the same value would compare unequal across SDKs.
// proves: CLAIM(S11-tagged-values)
#[test]
fn an_integral_finite_float_encodes_as_a_plain_integer_number() {
    let limits = limits_from(&serde_json::Value::Null);
    assert_eq!(Value::Float(3.0).to_json(&limits), serde_json::json!(3));
    assert_eq!(Value::Float(-12.0).to_json(&limits), serde_json::json!(-12));
}

// why: display cells format a tagged value; the object record keeps the tag. The strings are the section 2 table, hand-written.
// proves: CLAIM(S11-tagged-values) CLAIM(S12-text-completeness)
#[test]
fn display_formats_tagged_values_for_cells_and_shape_examples() {
    let fixture = load("values.json");
    let cases = fixture["display"]["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 9, "the display table lost a row");
    for case in cases {
        assert_eq!(value_from_spec(&case["input"]).display(), case["text"].as_str().unwrap(), "display of {}", case["input"]);
    }
}

// why: defaults are the spec's numbers (section 4); a changed default silently changes what is dropped. v0's factItemsPerView (10_000)
// bounds rows per view because the spec gives no per-view row cap (docs/v1-red-contract.md section 5).
// proves: CLAIM(IV9)
#[test]
fn default_limits_are_the_spec_numbers() {
    let expected = Limits { depth: 4, objects: 1000, references: 4000, root_bytes: 2 * 1024 * 1024, string_bytes: 16 * 1024, page_rows: 100, collection_bytes: 32 * 1024 * 1024, roots: 100, view_rows: 10_000, view_budget_ms: 100 };
    assert_eq!(Limits::default(), expected);
}
