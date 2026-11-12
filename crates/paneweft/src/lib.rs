//! Paneweft Rust SDK.
//!
//! Layers (spec section 2): the authoring layer takes domain values, columns, fields and object references through a [`Context`];
//! the encoding layer turns them into `paneweft.object-graph/1` documents. Development only: gate every use behind a cargo
//! feature of the host crate (`cfg(feature = "paneweft")`); `debug_assertions` alone is not a gate.
//!
//! Vocabulary: a *type* is a stable repository-owned id; a *view definition* is a typed function that answers one question about it;
//! an *example definition* is a named factory with checks that returns a value of the type; an *example invocation* is one run of an
//! example (an attempt); a *capture* is the immutable object graph one invocation (or an `inspect` call) published.
pub use linkme;
pub use paneweft_macros::{example, view, views};
pub use serde_json;

pub mod artifacts;
pub mod builders;
pub mod capture;
pub mod catalogue;
pub mod example;
mod json;
pub mod limits;
mod bounded;
pub mod trail;
pub mod value;

pub use builders::{Ascending, Bounded, DetailsBuilder, Descending, Direction, Row, TableBuilder, View};
pub use capture::{
    inspect, with_capture, Capture, CaptureOptions, Context, InspectOutcome, Inspectable, ObjectGraph, ObjectRef, ViewEntry, ViewError,
    ViewMeta, ViewResult, ViewSetResult,
};
pub use catalogue::{Catalogue, CatalogueError, ExampleDescriptor, ExampleKind, SourceLocation, ViewDescriptor};
pub use limits::Limits;
pub use value::Value;

/// Records one domain check under a claim id; inside an example the failure is reported (and cargo fails) once the body has returned
/// its value, outside an example it fails at once (spec section 3). `check!("VW1", cond)`.
#[macro_export]
macro_rules! check {
    ($claim:expr, $cond:expr $(,)?) => {
        $crate::example::check_lazy($claim, $cond, || ::std::string::String::from(stringify!($cond)))
    };
}

/// `check_eq!("VW1", left, right)`: `assert_eq!` semantics plus a recorded outcome under the claim id.
#[macro_export]
macro_rules! check_eq {
    ($claim:expr, $left:expr, $right:expr $(,)?) => {
        match (&$left, &$right) {
            (left, right) => $crate::example::check_lazy($claim, *left == *right, || {
                ::std::format!("{} == {} (left: {:?}, right: {:?})", stringify!($left), stringify!($right), left, right)
            }),
        }
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
