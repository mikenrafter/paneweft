//! SEEDED FAILURES (S6, IV17): selected by explicit example id only. They live in their own test target so an unfiltered run of the
//! lib target stays green. Each one fails in a different way.
#![cfg(feature = "paneweft")]
use watchfile::{WatchFile, WatchStatus};

paneweft::test_adapter!();

#[paneweft::example(id = "watch.seeded-failure", claims = ["VWX"])]
fn seeded_failure() -> WatchFile {
    let watch = WatchFile::pending();
    paneweft::check_eq!("VWX", watch.status, WatchStatus::Cancelled); // wrong on purpose
    watch
}

#[paneweft::example(id = "watch.seeded-error", claims = [])]
fn seeded_error() -> WatchFile {
    panic!("seeded panic that is not a check")
}
