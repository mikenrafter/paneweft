//! Deliberate compiler-contract tests (spec section 10: they do not replace the assertion-based red gate; they pin the diagnostics
//! authors see). Each case is an example of fixtures/crates/compile-contract compiled with `cargo check` in a separate target
//! directory (the outer cargo holds the workspace target lock).
use std::path::PathBuf;
use std::process::Command;

fn check(example: &str) -> (bool, String) {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/crates/compile-contract/Cargo.toml");
    let target = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/compile-contract");
    let output = Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()))
        .args(["check", "--quiet", "--manifest-path"])
        .arg(&manifest)
        .args(["--example", example, "--color", "never"])
        .env("CARGO_TARGET_DIR", &target)
        .output()
        .expect("spawn cargo");
    (output.status.success(), String::from_utf8_lossy(&output.stderr).into_owned())
}

fn must_fail_with(example: &str, phrase: &str) {
    let (success, stderr) = check(example);
    assert!(!success, "{example} compiled, but the contract says it must not:\n{stderr}");
    assert!(stderr.contains(phrase), "{example}: the diagnostic should contain {phrase:?}, got:\n{stderr}");
    assert!(stderr.contains(&format!("examples/{example}.rs")), "{example}: the diagnostic should point into the author's file, got:\n{stderr}");
}

// why: spec decision 4: concrete types only; generic instantiations need explicit registration. The error must say so, not "expected ...".
// proves: CLAIM(IV3) CLAIM(IV2)
#[test]
fn views_on_a_generic_impl_is_rejected_with_a_clear_message() {
    must_fail_with("generic_impl", "concrete types only");
}

// why: an orphan #[view] silently doing nothing is the worst failure mode of an attribute DSL.
// proves: CLAIM(IV3)
#[test]
fn a_view_attribute_outside_a_views_impl_is_rejected() {
    must_fail_with("view_outside_views", "inside a `#[paneweft::views]` impl");
}

// why: examples are factories with no input, so a parameter can never be supplied by the generated libtest wrapper.
// proves: CLAIM(IV5)
#[test]
fn an_example_with_parameters_is_rejected() {
    must_fail_with("example_with_parameters", "take no parameters");
}

// why: the type id is the stable repository-owned identity of the catalogue; omitting it must not default to a path.
// proves: CLAIM(IV3)
#[test]
fn views_without_a_type_id_is_rejected() {
    must_fail_with("missing_type_id", "requires `type_id");
}

// why: IV18 control. rustc catches a renamed field inside a view body, with a span in the author's own file. This passes against the
// stub too (the stub leaves the body untouched): it is a positive control that the macro must not swallow or relocate the span.
// proves: CLAIM(IV18)
#[test]
fn a_renamed_field_in_a_view_body_fails_to_compile_in_the_authors_file() {
    let (success, stderr) = check("renamed_field");
    assert!(!success, "a view referencing a removed field compiled");
    assert!(stderr.contains("no field `tick`"), "{stderr}");
    assert!(stderr.contains("examples/renamed_field.rs"), "{stderr}");
}
