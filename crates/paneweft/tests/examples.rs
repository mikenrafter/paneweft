//! Examples as tests (IV5, IV6 (zero-check), IV7) and the outcome vocabulary (S6, N4) at invocation level.
//! The macro examples below are ordinary functions: composing them is a normal call, as `<gtExample>` factories do.
mod support;
use paneweft::example::{expect_failure, invoke, invoke_result, take_invocations, Matcher, NativeOutcome};
use paneweft::{ExampleDescriptor, ExampleKind, Inspectable, SourceLocation};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicUsize, Ordering};
use support::{WatchFile, WatchStatus};

#[paneweft::example(id = "watch.pending", claims = ["VW1"])]
fn pending_watch() -> WatchFile {
    static BUILT: AtomicUsize = AtomicUsize::new(0);
    BUILT.fetch_add(1, Ordering::SeqCst);
    let watch = WatchFile::pending();
    paneweft::check_eq!("VW1", watch.status, WatchStatus::Pending);
    watch
}

#[paneweft::example(id = "watch.cancelled", claims = ["VW2", "VW2-empty"])]
fn cancelled_watch() -> WatchFile {
    let mut watch = pending_watch();
    watch.status = WatchStatus::Cancelled;
    paneweft::check_eq!("VW2", watch.status, WatchStatus::Cancelled);
    paneweft::check!("VW2-empty", watch.events.is_empty());
    watch
}

fn reset() {
    let _ = take_invocations();
}

static DESCRIPTOR_A: ExampleDescriptor = ExampleDescriptor { id: "ex.a", type_id: "fixture::watch::WatchFile", claims: &["CA"], module: "examples", source: SourceLocation { file: "tests/examples.rs", line: 1 }, test_name: "ex_a", kind: ExampleKind::Example };
static DESCRIPTOR_B: ExampleDescriptor = ExampleDescriptor { id: "ex.b", type_id: "fixture::watch::WatchFile", claims: &["CB"], module: "examples", source: SourceLocation { file: "tests/examples.rs", line: 2 }, test_name: "ex_b", kind: ExampleKind::Example };
static DEAD_END: ExampleDescriptor = ExampleDescriptor { id: "dead.end", type_id: "fixture::watch::WatchFile", claims: &["DE"], module: "examples", source: SourceLocation { file: "tests/examples.rs", line: 3 }, test_name: "dead_end", kind: ExampleKind::DeadEnd };

// why: IV5/IV7. A direct call of a composed example records a parent edge: the invocation of `cancelled` is the parent of the
// invocation of `pending`, started in that order, both passed with their own checks recorded under their claim ids.
// proves: CLAIM(IV5) CLAIM(IV7)
#[test]
fn a_composed_example_records_parent_edges_and_its_checks() {
    reset();
    let watch = cancelled_watch();
    assert_eq!(watch.status, WatchStatus::Cancelled, "the example returns the asserted value");
    let invocations = take_invocations();
    assert_eq!(invocations.iter().map(|i| i.example_id.as_str()).collect::<Vec<_>>(), vec!["watch.cancelled", "watch.pending"]);
    assert_eq!(invocations[0].parent, None);
    assert_eq!(invocations[1].parent.as_deref(), Some(invocations[0].id.as_str()));
    assert_eq!(invocations[0].native, NativeOutcome::Passed);
    assert_eq!(invocations[1].native, NativeOutcome::Passed);
    assert_eq!(invocations[0].checks.iter().map(|c| (c.claim.as_str(), c.passed)).collect::<Vec<_>>(), vec![("VW2", true), ("VW2-empty", true)]);
    assert_eq!(invocations[1].checks.iter().map(|c| (c.claim.as_str(), c.passed)).collect::<Vec<_>>(), vec![("VW1", true)]);
    assert!(invocations[0].verified && invocations[1].verified);
}

// why: IV7. v1 does not memoize mutable fixtures: each call runs the factory body again and gets a fresh value. A cached success
// would leave the counter at 1 after two calls.
// proves: CLAIM(IV7)
#[test]
fn each_call_builds_a_fresh_value() {
    reset();
    let first = pending_watch();
    let mut second = pending_watch();
    second.tick = 99;
    assert_eq!(first.tick, 0, "the first value must not alias the second");
    assert_eq!(take_invocations().len(), 2, "two calls, two invocations");
}

// why: IV6 (the zero-check rule). Without an executed recorded domain check an invocation is exploratory, even though it passed.
// proves: CLAIM(IV6) CLAIM(S6-outcomes)
#[test]
fn an_invocation_with_no_recorded_check_passes_but_is_not_verified() {
    reset();
    let _ = invoke(&DESCRIPTOR_A, || WatchFile::pending());
    let invocations = take_invocations();
    assert_eq!(invocations.len(), 1);
    assert_eq!(invocations[0].native, NativeOutcome::Passed);
    assert!(invocations[0].checks.is_empty());
    assert!(!invocations[0].verified, "exploratory, not verified");
}

// why: IV5/S6. A failing check keeps the test failing (the panic is resumed after recording) and is a `Failed` outcome carrying the
// failed claim; it is not an `Error`.
// proves: CLAIM(IV5) CLAIM(S6-outcomes)
#[test]
fn a_failing_check_is_recorded_as_failed_and_the_panic_is_resumed() {
    reset();
    let unwound = catch_unwind(AssertUnwindSafe(|| {
        invoke(&DESCRIPTOR_A, || {
            paneweft::check!("CA", 1 + 1 == 3);
            WatchFile::pending()
        })
    }));
    assert!(unwound.is_err(), "cargo must still see the failure");
    let invocations = take_invocations();
    assert_eq!(invocations.len(), 1);
    assert!(matches!(invocations[0].native, NativeOutcome::Failed(_)), "{:?}", invocations[0].native);
    assert_eq!(invocations[0].checks.iter().map(|c| (c.claim.as_str(), c.passed)).collect::<Vec<_>>(), vec![("CA", false)]);
    assert!(!invocations[0].verified);
}

// why: S6. A panic that is not a check and a `Result::Err` are both failures of kind `Error`, and the Err keeps its Debug text as
// the structured diagnostic message.
// proves: CLAIM(S6-outcomes) CLAIM(IV5)
#[test]
fn a_plain_panic_and_a_result_err_are_errors() {
    reset();
    let panicked = catch_unwind(AssertUnwindSafe(|| invoke(&DESCRIPTOR_A, || -> WatchFile { panic!("boom") })));
    assert!(panicked.is_err());
    let returned = invoke_result(&DESCRIPTOR_B, || -> Result<WatchFile, String> { Err("fixture parse failed".to_string()) });
    assert!(returned.is_err(), "the Err value is returned to the caller unchanged");
    let invocations = take_invocations();
    assert_eq!(invocations.len(), 2);
    assert!(matches!(&invocations[0].native, NativeOutcome::Error(message) if message.contains("boom")), "{:?}", invocations[0].native);
    assert!(matches!(&invocations[1].native, NativeOutcome::Error(message) if message.contains("fixture parse failed")), "{:?}", invocations[1].native);
}

// why: S6. A failed child blocks its parent ("blocked by"), the parent is not reported as failed; the child keeps its own failure.
// proves: CLAIM(S6-outcomes) CLAIM(IV7)
#[test]
fn a_failed_child_blocks_its_parent() {
    reset();
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        invoke(&DESCRIPTOR_A, || {
            let _child = invoke(&DESCRIPTOR_B, || -> WatchFile { panic!("child broke") });
            WatchFile::pending()
        })
    }));
    assert!(outcome.is_err());
    let invocations = take_invocations();
    let parent = invocations.iter().find(|i| i.example_id == "ex.a").expect("parent invocation");
    let child = invocations.iter().find(|i| i.example_id == "ex.b").expect("child invocation");
    assert!(matches!(child.native, NativeOutcome::Error(_)));
    assert_eq!(parent.native, NativeOutcome::Blocked { by: child.id.clone() });
}

// why: IV7. A recursive example call stops with the invocation path and a bounded diagnostic instead of overflowing the stack.
// proves: CLAIM(IV7)
#[test]
fn a_recursive_example_call_stops_with_its_path() {
    reset();
    // The depth counter is test scaffolding: it keeps a missing recursion guard an assertion failure instead of a stack overflow
    // that would abort the whole test binary. A correct guard stops the recursion at the second entry of ex.a, long before 20.
    thread_local!(static DEPTH: std::cell::Cell<u32> = std::cell::Cell::new(0));
    fn deeper() -> bool {
        DEPTH.with(|d| { d.set(d.get() + 1); d.get() > 20 })
    }
    fn a() -> WatchFile {
        invoke(&DESCRIPTOR_A, || {
            if deeper() { return WatchFile::pending(); }
            let _ = b();
            WatchFile::pending()
        })
    }
    fn b() -> WatchFile {
        invoke(&DESCRIPTOR_B, || {
            if deeper() { return WatchFile::pending(); }
            a()
        })
    }
    let outcome = catch_unwind(AssertUnwindSafe(|| a()));
    assert!(outcome.is_err());
    let invocations = take_invocations();
    assert!(invocations.len() <= 8, "the recursion must be cut, got {} invocations", invocations.len());
    let message = invocations.iter().find_map(|i| match &i.native { NativeOutcome::Error(m) if m.contains("recursive") => Some(m.clone()), _ => None });
    assert!(message.expect("a recursion diagnostic").contains("ex.a -> ex.b -> ex.a"));
}

// why: N4 control 1. A matched failure inside expect_failure is captured, not propagated as "blocked by"; the dead-end example
// passes, its reproduced failure keeps a diagnostic id, and the child invocation remains recorded as failed.
// proves: CLAIM(N4-expected-failure) CLAIM(S8-dead-end)
#[test]
fn expect_failure_passes_only_when_the_failure_matches() {
    reset();
    let captured = invoke(&DEAD_END, || {
        let failure = expect_failure(Matcher::message_contains("lock held"), || invoke(&DESCRIPTOR_B, || -> WatchFile { panic!("userspace lock held by dead pid") }));
        assert!(failure.message.contains("lock held"));
        assert!(!failure.diagnostic_id.is_empty(), "the reproduced failure keeps a diagnostic");
        WatchFile::pending()
    });
    assert_eq!(captured.tick, 0);
    let invocations = take_invocations();
    let dead_end = invocations.iter().find(|i| i.example_id == "dead.end").unwrap();
    assert_eq!(dead_end.native, NativeOutcome::Passed);
    assert_eq!(dead_end.expected_failure_matched, Some(true));
    assert!(matches!(invocations.iter().find(|i| i.example_id == "ex.b").unwrap().native, NativeOutcome::Error(_)), "the child's own failure is kept");
}

// why: N4 control 2. Unexpected success fails the example: a dead end that no longer fails is a stale claim.
// proves: CLAIM(N4-expected-failure)
#[test]
fn expect_failure_fails_on_unexpected_success() {
    reset();
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        invoke(&DEAD_END, || {
            let _ = expect_failure(Matcher::Any, || invoke(&DESCRIPTOR_B, || WatchFile::pending()));
            WatchFile::pending()
        })
    }));
    assert!(outcome.is_err(), "an unexpected success must fail the example");
    let dead_end = take_invocations().into_iter().find(|i| i.example_id == "dead.end").unwrap();
    assert!(matches!(&dead_end.native, NativeOutcome::Failed(m) if m.contains("unexpected success")), "{:?}", dead_end.native);
}

// why: N4 control 3. An unrelated error also fails the example: matching the failure, not any failure, is the point.
// proves: CLAIM(N4-expected-failure)
#[test]
fn expect_failure_fails_on_an_unrelated_error() {
    reset();
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        invoke(&DEAD_END, || {
            let _ = expect_failure(Matcher::message_contains("lock held"), || invoke(&DESCRIPTOR_B, || -> WatchFile { panic!("disk full") }));
            WatchFile::pending()
        })
    }));
    assert!(outcome.is_err());
    let dead_end = take_invocations().into_iter().find(|i| i.example_id == "dead.end").unwrap();
    assert!(matches!(&dead_end.native, NativeOutcome::Failed(m) if m.contains("disk full") && m.contains("lock held")), "the message must show both the unrelated error and the expectation: {:?}", dead_end.native);
}

// why: IV5. The macro-generated wrapper is an ordinary libtest test that exists under a stable name and calls the example. Calling the
// wrapper directly (as cargo does) records the same invocations as calling the function.
// proves: CLAIM(IV5)
#[test]
fn the_generated_wrapper_runs_the_example_under_libtest() {
    reset();
    paneweft_example_pending_watch();
    let invocations = take_invocations();
    assert_eq!(invocations.iter().map(|i| i.example_id.as_str()).collect::<Vec<_>>(), vec!["watch.pending"]);
    assert_eq!(<WatchFile as Inspectable>::PANEWEFT_TYPE_ID, "fixture::watch::WatchFile");
}
