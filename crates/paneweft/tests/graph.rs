//! Object identity, cycles, shared children, domain keys and bounds (IV9), against literal graphs shared with the TypeScript SDK.
mod support;
use support::{expected_objects, load, run_scenario};

macro_rules! scenario_test {
    ($name:ident, $file:literal) => {
        // why: the scenario file states its own WHY; the expected graph was written by hand (hashes via sha256sum of `hashInput`).
        // proves: CLAIM(IV9) CLAIM(S11-alias)
        #[test]
        fn $name() {
            let scenario = load(concat!("graphs/", $file, ".json"));
            let graph = run_scenario(&scenario);
            assert_eq!(graph["roots"], scenario["expected"]["roots"], "{}: roots", $file);
            assert_eq!(graph["objects"], expected_objects(&scenario), "{}: objects ({})", $file, scenario["why"]);
            assert_eq!(graph["completeness"]["status"], scenario["expected"]["completeness"]["status"], "{}: completeness status", $file);
            assert_eq!(graph["completeness"].get("omitted"), scenario["expected"]["completeness"].get("omitted"), "{}: named omissions", $file);
        }
    };
}

scenario_test!(a_shared_child_converges_on_one_object_and_the_second_edge_is_an_alias, "shared-child");
scenario_test!(a_cycle_terminates_with_a_cycle_edge_to_the_ancestor, "cycle");
scenario_test!(a_self_reference_is_a_cycle_edge, "self-cycle");
scenario_test!(repeated_domain_keys_with_different_contents_stay_distinct, "duplicate-domain-keys");
scenario_test!(the_depth_limit_refuses_with_a_reason_and_a_count, "depth-limit");
scenario_test!(the_object_limit_refuses_with_a_reason_and_a_count, "object-limit");
scenario_test!(the_reference_limit_refuses_with_a_reason_and_a_count, "reference-limit");
scenario_test!(separate_unkeyed_publish_calls_are_separate_observations, "separate-observations");
scenario_test!(an_explicit_identity_token_makes_two_publish_calls_one_observation, "identity-token");

// why: the scenario list above must not shrink silently (test-quality: iterating over the current set).
// proves: CLAIM(IV9)
#[test]
fn the_pinned_scenario_files_exist() {
    for name in ["shared-child", "cycle", "self-cycle", "duplicate-domain-keys", "depth-limit", "object-limit", "reference-limit", "separate-observations", "identity-token"] {
        assert!(support::fixtures_dir().join(format!("graphs/{name}.json")).exists(), "{name}");
    }
}

// why: wire ids are opaque capture-scoped identifiers and never memory addresses (spec section 4). The ids of a fresh capture of the
// same graph must be identical run to run; an address-derived id would differ between two captures of two allocations.
// proves: CLAIM(IV9)
#[test]
fn object_ids_are_deterministic_registration_order_not_addresses() {
    let scenario = load("graphs/shared-child.json");
    let first = run_scenario(&scenario);
    let second = run_scenario(&scenario);
    assert_eq!(first["objects"], second["objects"]);
    let ids: Vec<&str> = first["objects"].as_array().unwrap().iter().map(|o| o["id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec!["o1", "o2", "o3", "o4"]);
}

// why: the content hash is sha256 of the canonical JSON of {domainKey, fields, label, typeId}. Two same-key objects differ only in
// content; equal content must hash equal, different content must not (IV21: no collapse of duplicate keys).
// proves: CLAIM(IV9) CLAIM(IV21)
#[test]
fn content_hashes_distinguish_redelivered_duplicates() {
    let graph = run_scenario(&load("graphs/duplicate-domain-keys.json"));
    let objects = graph["objects"].as_array().unwrap();
    assert_eq!(objects[1]["domainKey"], objects[2]["domainKey"]);
    assert_ne!(objects[1]["contentHash"], objects[2]["contentHash"]);
}
