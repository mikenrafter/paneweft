//! Examples as tests: invocation records, parent edges, checks and expected failures (spec section 3; amendments S6 and N4).
//! Stable libtest only; no custom test framework.
//!
//! The generated function wraps its own body in [`invoke`], so a direct call from another example records a parent edge. A failed
//! check is recorded and the panic is deferred until the body has returned its value, so the failing example still publishes the
//! object it built (failed tests retain valid objects). Cargo sees the panic, resumed after the record is written.
use crate::artifacts::{limits_from_env, staging_from_env, write_or_report, write_text_or_report, Staging};
use crate::capture::{activate, deactivate, panic_message, Capture, CaptureOptions, Inspectable, ObjectRef};
use crate::catalogue::ExampleDescriptor;
use crate::json::now_rfc3339;
use serde_json::{json, Map, Value as Json};
use std::any::Any;
use std::cell::RefCell;
use std::panic::{catch_unwind, resume_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NativeOutcome {
    Passed,
    /// An assertion or recorded check failed.
    Failed(String),
    /// A panic that is not a check, or `Result::Err`.
    Error(String),
    /// A child example failed (outside an expected-failure boundary); this parent could not run on.
    Blocked { by: String },
}

/// Where a check was made: the `file!()` and `line!()` of the `check!` / `check_eq!` call (F10).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckLocation {
    pub file: String,
    pub line: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Check {
    pub claim: String,
    pub passed: bool,
    pub message: Option<String>,
    /// The call site of the macro that made the check; `None` for a check made through [`check`] / [`check_lazy`].
    pub location: Option<CheckLocation>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Invocation {
    pub id: String,
    pub example_id: String,
    pub attempt: u32,
    pub parent: Option<String>,
    pub native: NativeOutcome,
    pub checks: Vec<Check>,
    /// Passed with at least one executed recorded check and a captured result. A zero-check invocation is exploratory.
    pub verified: bool,
    pub expected_failure_matched: Option<bool>,
}

/// The payload a failed child leaves in its parent's unwind, so the parent can tell "a child failed" (blocked) from "I failed".
struct Propagated {
    origin: String,
    original: Box<dyn Any + Send>,
}

struct ExpectedFailure {
    matched: bool,
    diagnostic_id: String,
    message: String,
}

struct Frame {
    slot: usize,
    id: String,
    example_id: &'static str,
    parent: Option<String>,
    attempt: u32,
    started_at: String,
    checks: Vec<Check>,
    pending_failure: Option<String>,
    expected_failure: Option<ExpectedFailure>,
}

thread_local! {
    static RECORDS: RefCell<Vec<Invocation>> = const { RefCell::new(Vec::new()) };
    static STACK: RefCell<Vec<Frame>> = const { RefCell::new(Vec::new()) };
}

static COUNTER: AtomicU64 = AtomicU64::new(1);

fn next_id() -> String {
    format!("inv-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed))
}

fn native_json(native: &NativeOutcome) -> Json {
    let cut = |text: &str| crate::value::cut_str(text, 2000).0.to_string();
    match native {
        NativeOutcome::Passed => json!({"outcome": "passed"}),
        NativeOutcome::Failed(message) => json!({"outcome": "failed", "message": cut(message)}),
        NativeOutcome::Error(message) => json!({"outcome": "error", "message": cut(message)}),
        NativeOutcome::Blocked { by } => json!({"outcome": "blocked", "blockedBy": by}),
    }
}

fn checks_json(checks: &[Check]) -> Json {
    Json::Array(
        checks
            .iter()
            .map(|check| {
                let mut entry = Map::new();
                entry.insert("claim".into(), json!(check.claim));
                entry.insert("passed".into(), json!(check.passed));
                if let Some(message) = &check.message {
                    entry.insert("message".into(), json!(crate::value::cut_str(message, 1000).0));
                }
                if let Some(location) = &check.location {
                    entry.insert("source".into(), json!({"path": location.file, "line": location.line}));
                }
                Json::Object(entry)
            })
            .collect(),
    )
}

/// What publishing the example's result did.
struct CaptureSummary {
    outcome: &'static str,
    capture_id: Option<String>,
    diagnostics: Vec<String>,
    root: Option<String>,
}

fn started_record(frame: &Frame) -> Json {
    json!({"id": frame.id, "exampleId": frame.example_id, "attempt": frame.attempt, "parent": frame.parent, "startedAt": frame.started_at})
}

fn completion_record(frame: &Frame, native: &NativeOutcome, verified: bool, summary: &CaptureSummary) -> Json {
    let mut capture = Map::new();
    capture.insert("outcome".into(), json!(summary.outcome));
    if let Some(id) = &summary.capture_id {
        capture.insert("captureId".into(), json!(id));
    }
    capture.insert("diagnostics".into(), json!(summary.diagnostics));
    let mut record = Map::new();
    record.insert("id".into(), json!(frame.id));
    record.insert("exampleId".into(), json!(frame.example_id));
    record.insert("attempt".into(), json!(frame.attempt));
    record.insert("parent".into(), json!(frame.parent));
    record.insert("native".into(), native_json(native));
    record.insert("capture".into(), Json::Object(capture));
    record.insert("checks".into(), checks_json(&frame.checks));
    record.insert("verified".into(), json!(verified));
    if let (Some(capture_id), Some(root)) = (&summary.capture_id, &summary.root) {
        record.insert("result".into(), json!({"captureId": capture_id, "object": root}));
    }
    if let Some(expected) = &frame.expected_failure {
        record.insert("expectedFailure".into(), json!({"matched": expected.matched, "diagnosticId": expected.diagnostic_id}));
    }
    record.insert("startedAt".into(), json!(frame.started_at));
    record.insert("finishedAt".into(), json!(now_rfc3339()));
    Json::Object(record)
}

/// Opens an invocation: allocates its record slot (so records come back in START order), writes the started record, and pushes the
/// frame. A recursive call is cut here with the invocation path.
fn begin(descriptor: &ExampleDescriptor, staging: Option<&Staging>) -> String {
    let id = next_id();
    let (parent, path) = STACK.with(|stack| {
        let stack = stack.borrow();
        let mut path: Vec<&str> = stack.iter().map(|frame| frame.example_id).collect();
        path.push(descriptor.id);
        (stack.last().map(|frame| frame.id.clone()), stack.iter().any(|frame| frame.example_id == descriptor.id).then(|| path.join(" -> ")))
    });
    let attempt = staging.map_or(1, |s| s.attempt);
    let slot = RECORDS.with(|records| {
        let mut records = records.borrow_mut();
        records.push(Invocation { id: id.clone(), example_id: descriptor.id.to_string(), attempt, parent: parent.clone(), native: NativeOutcome::Passed, checks: Vec::new(), verified: false, expected_failure_matched: None });
        records.len() - 1
    });
    let frame = Frame { slot, id: id.clone(), example_id: descriptor.id, parent, attempt, started_at: now_rfc3339(), checks: Vec::new(), pending_failure: None, expected_failure: None };
    if let Some(staging) = staging {
        write_or_report(&staging.dir.join("invocations").join(format!("{id}.started.json")), &started_record(&frame));
    }
    if let Some(path) = path {
        let message = format!("recursive example call: {path}");
        eprintln!("paneweft: {message}");
        let native = NativeOutcome::Error(message.clone());
        let summary = CaptureSummary { outcome: "none", capture_id: None, diagnostics: Vec::new(), root: None };
        finish_record(&frame, &native, false, staging, &summary);
        resume_unwind(Box::new(Propagated { origin: id, original: Box::new(message) }));
    }
    STACK.with(|stack| stack.borrow_mut().push(frame));
    id
}

fn finish_record(frame: &Frame, native: &NativeOutcome, verified: bool, staging: Option<&Staging>, summary: &CaptureSummary) {
    RECORDS.with(|records| {
        let mut records = records.borrow_mut();
        let record = &mut records[frame.slot];
        record.native = native.clone();
        record.checks = frame.checks.clone();
        record.verified = verified;
        record.expected_failure_matched = frame.expected_failure.as_ref().map(|expected| expected.matched);
    });
    if let Some(staging) = staging {
        write_or_report(&staging.dir.join("invocations").join(format!("{}.json", frame.id)), &completion_record(frame, native, verified, summary));
    }
}

fn pop_frame() -> Frame {
    STACK.with(|stack| stack.borrow_mut().pop()).expect("an invocation frame is open")
}

fn has_parent() -> bool {
    STACK.with(|stack| !stack.borrow().is_empty())
}

/// Re-raises a failure after its record is written. With a parent the unwind carries the origin, so the parent is `blocked`; at the top
/// the original payload is resumed so cargo and the test harness see the real message.
fn raise(origin: String, original: Box<dyn Any + Send>) -> ! {
    let original = match original.downcast::<Propagated>() {
        Ok(propagated) => propagated.original,
        Err(other) => other,
    };
    if has_parent() {
        resume_unwind(Box::new(Propagated { origin, original }))
    }
    resume_unwind(original)
}

/// Shared by [`invoke`] and [`invoke_result`]: runs `body`, records everything, publishes the result when collection is enabled.
fn run_invocation<R>(
    descriptor: &ExampleDescriptor,
    body: impl FnOnce() -> R,
    failure_of: impl Fn(&R) -> Option<String>,
    publish: impl FnOnce(&R, &mut Capture) -> Option<Result<ObjectRef, crate::capture::ViewError>>,
) -> R {
    let staging = staging_from_env();
    let id = begin(descriptor, staging.as_ref());
    let options = staging.as_ref().map(|s| CaptureOptions { capture_id: id.clone(), run_id: s.run_id.clone(), invocation_id: id.clone(), limits: limits_from_env() });
    if let Some(options) = &options {
        activate(Capture::new(options.clone()));
    }
    let outcome = catch_unwind(AssertUnwindSafe(body));
    let mut capture = options.as_ref().and_then(|_| deactivate());
    let frame = pop_frame();
    let mut summary = CaptureSummary { outcome: "none", capture_id: None, diagnostics: Vec::new(), root: None };
    let (native, value, payload) = match outcome {
        Ok(value) => {
            let native = match (&frame.pending_failure, failure_of(&value)) {
                (Some(message), _) => NativeOutcome::Failed(message.clone()),
                (None, Some(message)) => NativeOutcome::Error(message),
                (None, None) => NativeOutcome::Passed,
            };
            (native, Some(value), None)
        }
        Err(payload) => {
            let native = match payload.downcast_ref::<Propagated>() {
                Some(propagated) => NativeOutcome::Blocked { by: propagated.origin.clone() },
                None => match &frame.pending_failure {
                    Some(message) => NativeOutcome::Failed(message.clone()),
                    None => NativeOutcome::Error(panic_message(payload.as_ref())),
                },
            };
            (native, None, Some(payload))
        }
    };
    if let (Some(capture), Some(expected)) = (capture.as_mut(), frame.expected_failure.as_ref()) {
        if expected.matched {
            capture.add_diagnostic("assertion", &format!("expected failure reproduced: {}", expected.message), Some(descriptor.id), Some(expected.diagnostic_id.clone()));
        }
    }
    if let (Some(capture), Some(value)) = (capture.as_mut(), value.as_ref()) {
        match publish(value, capture) {
            Some(Ok(ObjectRef::Captured(root))) => summary.root = Some(root),
            Some(Ok(ObjectRef::NotCaptured { .. })) | Some(Err(_)) | None => {}
        }
    }
    if let (Some(capture), Some(staging), Some(options)) = (capture, staging.as_ref(), options.as_ref()) {
        summary.diagnostics = capture.diagnostic_ids();
        let failed = capture.has_fault();
        if value.is_some() || !summary.diagnostics.is_empty() {
            summary.capture_id = Some(options.capture_id.clone());
            let graph = capture.finish();
            write_text_or_report(&staging.dir.join("captures").join(format!("{}.json", options.capture_id)), graph.text());
        }
        summary.outcome = if summary.root.is_none() && value.is_none() { "none" } else if failed || summary.root.is_none() { "failed" } else { "captured" };
        if summary.root.is_none() && value.is_some() {
            summary.outcome = "failed";
        }
    }
    let verified = native == NativeOutcome::Passed && !frame.checks.is_empty() && frame.checks.iter().all(|check| check.passed) && (staging.is_none() || summary.outcome == "captured");
    finish_record(&frame, &native, verified, staging.as_ref(), &summary);
    match (native, value, payload) {
        (NativeOutcome::Passed, Some(value), _) => value,
        (NativeOutcome::Failed(message), Some(value), None) => {
            drop(value);
            eprintln!("paneweft: example {} failed: {message}", descriptor.id);
            if has_parent() {
                resume_unwind(Box::new(Propagated { origin: id, original: Box::new(message) }))
            }
            panic!("{message}")
        }
        // `invoke_result` returns its `Err` to the caller unchanged: the record says `error`, the caller decides what to do with it.
        (NativeOutcome::Error(_), Some(value), None) => value,
        (NativeOutcome::Blocked { by }, _, Some(payload)) => raise(by, payload),
        (_, _, Some(payload)) => raise(id, payload),
        _ => unreachable!("every non-passing outcome either carries a payload or is a deferred failure"),
    }
}

/// Runs an example body under a descriptor: records the invocation (parent edge from the active stack, fresh value per call),
/// captures the result while borrowed, writes artifacts when collection is enabled, then resumes any panic so cargo still fails.
pub fn invoke<T: Inspectable>(descriptor: &ExampleDescriptor, body: impl FnOnce() -> T) -> T {
    run_invocation(descriptor, body, |_| None, |value, capture| Some(capture.publish(value)))
}

/// `Result<T, E>` examples: `Ok` publishes `T`; `Err` is a failure with a structured diagnostic.
pub fn invoke_result<T: Inspectable, E: std::fmt::Debug>(descriptor: &ExampleDescriptor, body: impl FnOnce() -> Result<T, E>) -> Result<T, E> {
    run_invocation(
        descriptor,
        body,
        |result| result.as_ref().err().map(|error| format!("example returned Err: {error:?}")),
        |result, capture| result.as_ref().ok().map(|value| capture.publish(value)),
    )
}

/// Drains the invocations recorded on this thread, in start order.
pub fn take_invocations() -> Vec<Invocation> {
    RECORDS.with(|records| std::mem::take(&mut *records.borrow_mut()))
}

/// Records one check under a claim id. Inside an example the failure is deferred until the body has returned (so the object it built
/// is still captured) and then fails natively; outside an example it fails immediately.
pub fn check(claim: &str, passed: bool, text: &str) {
    check_lazy(claim, passed, || text.to_string());
}

/// As [`check`], formatting the description only when the check fails.
pub fn check_lazy(claim: &str, passed: bool, text: impl FnOnce() -> String) {
    record_check(claim, passed, None, text);
}

/// As [`check_lazy`], for a check made at `file`:`line`: what the `check!` and `check_eq!` macros call with `file!()` and `line!()`, so a failed check is reported where the author
/// wrote it and not at the panic inside this crate (F10).
pub fn check_at(claim: &str, passed: bool, file: &str, line: u32, text: impl FnOnce() -> String) {
    record_check(claim, passed, Some(CheckLocation { file: file.to_string(), line }), text);
}

fn record_check(claim: &str, passed: bool, location: Option<CheckLocation>, text: impl FnOnce() -> String) {
    let message = (!passed).then(|| format!("check {claim} failed: {}", text()));
    let recorded = STACK.with(|stack| match stack.borrow_mut().last_mut() {
        Some(frame) => {
            frame.checks.push(Check { claim: claim.to_string(), passed, message: message.clone(), location });
            if let (Some(message), None) = (&message, &frame.pending_failure) {
                frame.pending_failure = Some(message.clone());
            }
            true
        }
        None => false,
    });
    if !recorded {
        if let Some(message) = message {
            panic!("{message}");
        }
    }
}

/// Matches the message of a captured failure.
#[derive(Clone, Debug)]
pub enum Matcher {
    Any,
    MessageContains(String),
}

impl Matcher {
    pub fn message_contains(text: &str) -> Matcher { Matcher::MessageContains(text.to_string()) }

    fn matches(&self, message: &str) -> bool {
        match self {
            Matcher::Any => true,
            Matcher::MessageContains(text) => message.contains(text.as_str()),
        }
    }

    fn describe(&self) -> String {
        match self {
            Matcher::Any => "any failure".to_string(),
            Matcher::MessageContains(text) => format!("a failure containing {text:?}"),
        }
    }
}

/// What a matched failure left behind.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapturedFailure {
    pub message: String,
    pub diagnostic_id: String,
}

/// Fails the innermost example: the message is deferred into its frame (so the record says `failed`) and the panic carries it.
fn fail_current(message: String) -> ! {
    STACK.with(|stack| {
        if let Some(frame) = stack.borrow_mut().last_mut() {
            if frame.pending_failure.is_none() {
                frame.pending_failure = Some(message.clone());
            }
        }
    });
    panic!("{message}")
}

/// `expect_failure(matcher, || ...)` (spec N4): inside the boundary a child failure is captured, not propagated as "blocked by";
/// the example passes only when the failure matches. An unexpected success or an unrelated error fails the example (this function
/// panics after recording).
pub fn expect_failure<R>(matcher: Matcher, body: impl FnOnce() -> R) -> CapturedFailure {
    match catch_unwind(AssertUnwindSafe(body)) {
        Ok(_) => {
            note_expected_failure(false, None);
            fail_current(format!("unexpected success: expected {} but the body completed", matcher.describe()))
        }
        Err(payload) => {
            let original = match payload.downcast::<Propagated>() {
                Ok(propagated) => propagated.original,
                Err(other) => other,
            };
            let message = panic_message(original.as_ref());
            if matcher.matches(&message) {
                let diagnostic_id = note_expected_failure(true, Some(message.clone()));
                CapturedFailure { message, diagnostic_id }
            } else {
                note_expected_failure(false, Some(message.clone()));
                fail_current(format!("expected {} but the body failed with: {message}", matcher.describe()))
            }
        }
    }
}

fn note_expected_failure(matched: bool, message: Option<String>) -> String {
    STACK.with(|stack| match stack.borrow_mut().last_mut() {
        Some(frame) => {
            let diagnostic_id = format!("diag-{}-expected-failure", frame.id);
            frame.expected_failure = Some(ExpectedFailure { matched, diagnostic_id: diagnostic_id.clone(), message: message.unwrap_or_default() });
            diagnostic_id
        }
        None => "diag-expected-failure".to_string(),
    })
}
