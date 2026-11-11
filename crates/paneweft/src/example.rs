//! Examples as tests: invocation records, parent edges, checks and expected failures (spec section 3; amendments S6 and N4).
//! Stable libtest only; no custom test framework.
use crate::capture::Inspectable;
use crate::catalogue::ExampleDescriptor;

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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Check {
    pub claim: String,
    pub passed: bool,
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

/// Runs an example body under a descriptor: records the invocation (parent edge from the active stack, fresh value per call),
/// captures the result while borrowed, writes artifacts when collection is enabled, then resumes any panic so cargo still fails.
/// STUB: runs the body and records nothing.
pub fn invoke<T: Inspectable>(descriptor: &ExampleDescriptor, body: impl FnOnce() -> T) -> T {
    body()
}

/// `Result<T, E>` examples: `Ok` publishes `T`; `Err` is a failure with a structured diagnostic.
pub fn invoke_result<T: Inspectable, E: std::fmt::Debug>(descriptor: &ExampleDescriptor, body: impl FnOnce() -> Result<T, E>) -> Result<T, E> {
    body()
}

/// Drains the invocations recorded on this thread, in start order.
pub fn take_invocations() -> Vec<Invocation> {
    Vec::new()
}

/// Records one check under a claim id and fails natively when it does not hold. STUB: records nothing, does not fail.
pub fn check(claim: &str, passed: bool, text: &str) {}

/// Matches the message of a captured failure.
#[derive(Clone, Debug)]
pub enum Matcher {
    Any,
    MessageContains(String),
}

impl Matcher {
    pub fn message_contains(text: &str) -> Matcher { Matcher::MessageContains(text.to_string()) }
}

/// What a matched failure left behind.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapturedFailure {
    pub message: String,
    pub diagnostic_id: String,
}

/// `expect_failure(matcher, || ...)` (spec N4): inside the boundary a child failure is captured, not propagated as "blocked by";
/// the example passes only when the failure matches. An unexpected success or an unrelated error fails the example (this function
/// panics after recording). STUB: runs the body and returns an empty failure.
pub fn expect_failure<R>(matcher: Matcher, body: impl FnOnce() -> R) -> CapturedFailure {
    let _ = body();
    CapturedFailure { message: String::new(), diagnostic_id: String::new() }
}
