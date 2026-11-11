//! The decision trail builder (spec amendment S8). Produces `paneweft.trail/1`; lowering to notebook blocks is a host concern.
use paneweft::trail::{OptionStatus, Trail, TrailEntry, TrailOption};
use serde_json::json;

// why: S8. An abandoned option stays visible with its reason, supersession is by explicit id, and a dead end links to the runnable
// example that reproduces its failure. The expected document is the lock story from research note 13, written out by hand.
// proves: CLAIM(S8-trail-contract)
#[test]
fn a_trail_keeps_abandoned_options_with_reasons_and_explicit_supersession() {
    let trail = Trail::new("write-lock", "Why a kernel flock").entry(
        TrailEntry::new("e1", 1, "How should writers exclude each other?")
            .option(TrailOption::new("userspace", OptionStatus::Failed, "three rounds of recovery protocol still had a crash window").evidence_read("docs/contract-additions/store.md"))
            .option(TrailOption::new("flock", OptionStatus::Chosen, "the kernel releases the lock when the holder exits"))
            .decision("Use flock(1) through a helper process.")
            .dead_end_example("lock.userspace-recovery"),
    );
    assert_eq!(
        trail.to_json(),
        json!({
            "schemaVersion": "paneweft.trail/1",
            "id": "write-lock",
            "title": "Why a kernel flock",
            "entries": [{
                "id": "e1",
                "order": 1,
                "question": "How should writers exclude each other?",
                "options": [
                    {"id": "userspace", "status": "failed", "reason": "three rounds of recovery protocol still had a crash window", "evidence": [{"provenance": "read", "source": "docs/contract-additions/store.md"}]},
                    {"id": "flock", "status": "chosen", "reason": "the kernel releases the lock when the holder exits", "evidence": []}
                ],
                "decision": "Use flock(1) through a helper process.",
                "links": [],
                "deadEndExample": "lock.userspace-recovery"
            }]
        })
    );
}

// why: S8. Supersession is explicit by id, never inferred from order.
// proves: CLAIM(S8-trail-contract)
#[test]
fn supersession_is_recorded_by_explicit_entry_id() {
    let trail = Trail::new("t", "T")
        .entry(TrailEntry::new("e1", 1, "first?").option(TrailOption::new("a", OptionStatus::Chosen, "r")).decision("a"))
        .entry(TrailEntry::new("e2", 2, "again?").option(TrailOption::new("b", OptionStatus::Chosen, "r2")).decision("b").supersedes("e1"));
    assert_eq!(trail.to_json()["entries"][1]["supersedes"], json!("e1"));
    assert!(trail.to_json()["entries"][0].get("supersedes").is_none());
}

// why: S8/S11. The Rust builder and the TypeScript builder are held to the SAME literal document (fixtures/v1/trails/write-lock.json),
// so the two SDKs cannot drift apart.
// proves: CLAIM(S8-trail-contract)
#[test]
fn the_rust_trail_equals_the_shared_literal_fixture() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/v1/trails/write-lock.json");
    let fixture: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let trail = Trail::new("write-lock", "Why a kernel flock").entry(
        TrailEntry::new("e1", 1, "How should writers exclude each other?")
            .option(TrailOption::new("userspace", OptionStatus::Failed, "three rounds of recovery protocol still had a crash window").evidence_read("docs/contract-additions/store.md"))
            .option(TrailOption::new("flock", OptionStatus::Chosen, "the kernel releases the lock when the holder exits"))
            .decision("Use flock(1) through a helper process.")
            .dead_end_example("lock.userspace-recovery"),
    );
    assert_eq!(trail.to_json(), fixture);
}

// why: S20. The builder always wrote `links: []`, so a Rust trail could not point at the view, source, example or type behind a decision. A link
// keeps its kind, target and snapshot; a source link keeps its anchor. The expected document is written out by hand (the TypeScript builder passes the same members through).
// proves: CLAIM(S20-trail-links)
#[test]
fn an_entry_keeps_its_snapshot_bound_links() {
    use paneweft::trail::{LinkKind, TrailLink};
    let trail = Trail::new("t", "T").entry(
        TrailEntry::new("e1", 1, "q?")
            .option(TrailOption::new("a", OptionStatus::Chosen, "r"))
            .decision("a")
            .link(TrailLink::new(LinkKind::View, "lock.state", "snap-run-7"))
            .link(TrailLink::new(LinkKind::Source, "src/lock.rs", "snap-run-7").anchored("vg", "src/lock.rs", 10, 20))
            .link(TrailLink::new(LinkKind::Example, "lock.userspace-recovery", "snap-run-8"))
            .link(TrailLink::new(LinkKind::Type, "vigil::lock::Lock", "snap-run-7")),
    );
    assert_eq!(
        trail.to_json()["entries"][0]["links"],
        json!([
            {"kind": "view", "id": "lock.state", "snapshotId": "snap-run-7"},
            {"kind": "source", "id": "src/lock.rs", "snapshotId": "snap-run-7", "anchor": {"repository": "vg", "path": "src/lock.rs", "lines": [10, 20]}},
            {"kind": "example", "id": "lock.userspace-recovery", "snapshotId": "snap-run-8"},
            {"kind": "type", "id": "vigil::lock::Lock", "snapshotId": "snap-run-7"}
        ])
    );
}
