//! The artifact protocol between a test worker and the host collector (docs/v1-red-contract.md section 7).
mod support;
use paneweft::artifacts::{staging_from_env, Staging, ENV_ATTEMPT, ENV_CATALOGUE, ENV_COLLECT, ENV_RUN_ID, ENV_STAGING_DIR};
use paneweft::example::take_invocations;
use serde_json::{json, Value as Json};
use std::path::{Path, PathBuf};
use support::{WatchFile, WatchStatus, ENVIRONMENT};

paneweft::test_adapter!();

#[paneweft::example(id = "watch.pending", claims = ["VW1"])]
fn pending_watch() -> WatchFile {
    let watch = WatchFile::pending();
    paneweft::check_eq!("VW1", watch.status, WatchStatus::Pending);
    watch
}

static STAGING_SEEN_DURING_BODY: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

#[paneweft::example(id = "watch.observed-midflight", claims = ["VW3"])]
fn observing_watch() -> WatchFile {
    if let Some(staging) = staging_from_env() {
        let mut names: Vec<String> = std::fs::read_dir(staging.dir.join("invocations")).map(|d| d.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
        names.sort();
        *STAGING_SEEN_DURING_BODY.lock().unwrap() = names;
    }
    let watch = WatchFile::pending();
    paneweft::check!("VW3", true);
    watch
}

fn with_collection<R>(run_id: &str, body: impl FnOnce(&Path) -> R) -> R {
    let _guard = ENVIRONMENT.lock().unwrap_or_else(|e| e.into_inner());
    let dir = tempfile::tempdir().expect("tempdir");
    std::env::set_var(ENV_COLLECT, "1");
    std::env::set_var(ENV_RUN_ID, run_id);
    std::env::set_var(ENV_STAGING_DIR, dir.path());
    std::env::set_var(ENV_ATTEMPT, "2");
    let result = body(dir.path());
    for name in [ENV_COLLECT, ENV_RUN_ID, ENV_STAGING_DIR, ENV_ATTEMPT, ENV_CATALOGUE] {
        std::env::remove_var(name);
    }
    result
}

fn read_json(path: &Path) -> Json {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{} unreadable: {e}", path.display()))).expect("json")
}

fn files_in(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir).map(|d| d.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
    names.sort();
    names
}

// why: the collector hands the worker its identity through the environment; without the collect flag the SDK is silent. A suite run
// without a collector must execute assertions only: no server, no session, no files (spec section 3).
// proves: CLAIM(IV8) CLAIM(IV5)
#[test]
fn staging_is_read_from_the_environment_and_absent_without_the_collect_flag() {
    let _guard = ENVIRONMENT.lock().unwrap_or_else(|e| e.into_inner());
    std::env::remove_var(ENV_COLLECT);
    assert_eq!(staging_from_env(), None, "no collect flag, no staging");
    std::env::set_var(ENV_COLLECT, "1");
    std::env::set_var(ENV_RUN_ID, "run-abc");
    std::env::set_var(ENV_STAGING_DIR, "/tmp/paneweft-staging-x");
    std::env::set_var(ENV_ATTEMPT, "3");
    let seen = staging_from_env();
    std::env::set_var(ENV_COLLECT, "0");
    let disabled = staging_from_env();
    for name in [ENV_COLLECT, ENV_RUN_ID, ENV_STAGING_DIR, ENV_ATTEMPT] {
        std::env::remove_var(name);
    }
    assert_eq!(seen, Some(Staging { run_id: "run-abc".to_string(), dir: PathBuf::from("/tmp/paneweft-staging-x"), attempt: 3 }));
    assert_eq!(disabled, None, "PANEWEFT_COLLECT=0 disables collection");
}

// why: IV8/IV5. A collected invocation leaves a completion record carrying the REAL run id, attempt and checks, plus the capture it
// published, written under the staging directory the collector chose and nowhere else.
// proves: CLAIM(IV8) CLAIM(IV5) CLAIM(IV6)
#[test]
fn a_collected_example_writes_its_invocation_and_capture_artifacts() {
    take_invocations();
    with_collection("run-x", |staging| {
        let _ = pending_watch();
        let invocations = files_in(&staging.join("invocations"));
        let completion: Vec<&String> = invocations.iter().filter(|n| !n.ends_with(".started.json")).collect();
        assert_eq!(completion.len(), 1, "one completion record, got {invocations:?}");
        let record = read_json(&staging.join("invocations").join(completion[0]));
        let capture_id = record["capture"]["captureId"].as_str().expect("captureId").to_string();
        assert_eq!(record["exampleId"], "watch.pending");
        assert_eq!(record["attempt"], 2);
        assert_eq!(record["parent"], Json::Null);
        assert_eq!(record["native"], json!({"outcome": "passed"}));
        assert_eq!(record["checks"], json!([{"claim": "VW1", "passed": true}]));
        assert_eq!(record["verified"], true);
        assert_eq!(record["capture"]["outcome"], "captured");
        assert_eq!(record["result"], json!({"captureId": capture_id, "object": "o1"}));
        assert!(record["finishedAt"].is_string(), "a completion record has a finish time");
        let graph = read_json(&staging.join("captures").join(format!("{capture_id}.json")));
        assert_eq!(graph["schemaVersion"], "paneweft.object-graph/1");
        assert_eq!(graph["runId"], "run-x");
        assert_eq!(graph["objects"][0]["typeId"], "fixture::watch::WatchFile");
        assert_eq!(files_in(staging), vec!["captures".to_string(), "invocations".to_string()], "nothing outside the protocol directories");
    });
    take_invocations();
}

// why: a worker that aborts leaves a started record and no completion record; the collector counts it as missing (spec section 3,
// "process aborts and kills are handled as missing completion records"). The started record must therefore exist DURING the body.
// proves: CLAIM(IV17)
#[test]
fn a_started_record_exists_while_the_body_runs_and_the_completion_record_does_not() {
    take_invocations();
    with_collection("run-y", |_staging| {
        let _ = observing_watch();
    });
    let seen = STAGING_SEEN_DURING_BODY.lock().unwrap().clone();
    assert_eq!(seen.len(), 1, "exactly the started record during the body: {seen:?}");
    assert!(seen[0].ends_with(".started.json"), "{seen:?}");
    take_invocations();
}

// why: spec section 2: `paneweft::test_adapter!()` emits a reserved test that exports the catalogue to staging when the collector
// asks for it, without running any example body.
// proves: CLAIM(IV3) CLAIM(IV14)
#[test]
fn catalogue_export_writes_the_linked_catalogue_into_staging() {
    take_invocations();
    with_collection("run-z", |staging| {
        std::env::set_var(ENV_CATALOGUE, "1");
        paneweft_catalogue_export();
        let written = files_in(&staging.join("catalogue"));
        assert_eq!(written.len(), 1, "one file per test binary: {written:?}");
        let catalogue = read_json(&staging.join("catalogue").join(&written[0]));
        let ids: Vec<&str> = catalogue["examples"].as_array().unwrap().iter().map(|e| e["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["watch.observed-midflight", "watch.pending"]);
        assert!(take_invocations().is_empty(), "catalogue mode must not execute example bodies");
    });
}
