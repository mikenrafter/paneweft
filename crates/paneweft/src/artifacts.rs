//! The artifact protocol between the SDK in a test worker and the host collector (docs/v1-red-contract.md section 7).
//! A suite run without a collector still executes assertions; it neither starts a server nor creates a global session.
use std::path::PathBuf;

pub const ENV_COLLECT: &str = "PANEWEFT_COLLECT";
pub const ENV_RUN_ID: &str = "PANEWEFT_RUN_ID";
pub const ENV_STAGING_DIR: &str = "PANEWEFT_STAGING_DIR";
pub const ENV_ATTEMPT: &str = "PANEWEFT_ATTEMPT";
pub const ENV_CATALOGUE: &str = "PANEWEFT_CATALOGUE";

/// Collection settings read from the environment the collector set. `None` when collection is not enabled.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Staging {
    pub run_id: String,
    pub dir: PathBuf,
    pub attempt: u32,
}

/// STUB: always `None`.
pub fn staging_from_env() -> Option<Staging> { None }

/// Writes `<staging>/catalogue/<binary>.json` when `PANEWEFT_CATALOGUE=1`. STUB: writes nothing.
pub fn export_catalogue_if_requested() {}
