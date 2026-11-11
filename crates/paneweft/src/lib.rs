//! Paneweft Rust SDK.
//!
//! RED PHASE: every type and signature here is the contract; every body is a compile-only stub that does no work and publishes
//! nothing. Tests in `crates/paneweft/tests` fail on assertions against these stubs. Green replaces the bodies and deletes
//! `not_implemented()` (grep for it: it must be gone).
//!
//! Layers (spec section 2): the authoring layer takes domain values, columns, fields and object references through a [`Context`];
//! the encoding layer turns them into `paneweft.object-graph/1` documents. Development only: gate every use behind a cargo
//! feature of the host crate (`cfg(feature = "paneweft")`); `debug_assertions` alone is not a gate.
#![allow(unused_variables, dead_code)]

pub use linkme;
pub use paneweft_macros::{example, view, views};
pub use serde_json;

pub mod artifacts;
pub mod builders;
pub mod capture;
pub mod catalogue;
pub mod example;
pub mod limits;
pub mod trail;
pub mod value;

pub use builders::{Ascending, Bounded, DetailsBuilder, Descending, Direction, Row, TableBuilder, View};
pub use capture::{
    inspect, with_capture, Capture, CaptureOptions, Context, InspectOutcome, Inspectable, ObjectGraph, ObjectRef, ViewError,
    ViewMeta, ViewResult, ViewSetResult,
};
pub use catalogue::{Catalogue, CatalogueError, ExampleDescriptor, ExampleKind, SourceLocation, ViewDescriptor};
pub use limits::Limits;
pub use value::Value;

/// The marker every stub carries. Green must make `grep -r not_implemented crates` empty.
pub(crate) fn not_implemented(what: &str) -> ViewError {
    ViewError::not_implemented(what)
}

/// Records one domain check under a claim id and fails the test natively when it does not hold (spec section 3).
/// `check!("VW1", cond)` invokes the native assertion and records the outcome.
#[macro_export]
macro_rules! check {
    ($claim:expr, $cond:expr $(,)?) => {
        $crate::example::check($claim, $cond, stringify!($cond))
    };
}

/// `check_eq!("VW1", left, right)`: `assert_eq!` semantics plus a recorded outcome under the claim id.
#[macro_export]
macro_rules! check_eq {
    ($claim:expr, $left:expr, $right:expr $(,)?) => {
        $crate::example::check($claim, $left == $right, concat!(stringify!($left), " == ", stringify!($right)))
    };
}

/// One invocation in each participating test binary emits the reserved catalogue-export test (spec section 2).
/// The cargo adapter runs only tests whose name contains `paneweft_catalogue_export` in catalogue mode.
#[macro_export]
macro_rules! test_adapter {
    () => {
        #[cfg(test)]
        #[test]
        fn paneweft_catalogue_export() {
            $crate::artifacts::export_catalogue_if_requested();
        }
    };
}
