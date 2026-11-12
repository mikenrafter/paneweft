//! The artifact protocol between the SDK in a test worker and the host collector (docs/v1-red-contract.md section 7).
//! A suite run without a collector still executes assertions; it neither starts a server nor creates a global session.
use serde_json::Value as Json;
use std::path::{Path, PathBuf};

pub const ENV_COLLECT: &str = "PANEWEFT_COLLECT";
pub const ENV_RUN_ID: &str = "PANEWEFT_RUN_ID";
pub const ENV_STAGING_DIR: &str = "PANEWEFT_STAGING_DIR";
pub const ENV_ATTEMPT: &str = "PANEWEFT_ATTEMPT";
pub const ENV_CATALOGUE: &str = "PANEWEFT_CATALOGUE";
/// Optional JSON object of limit overrides (the wire `LimitOverrides`), set by the collector from the request.
pub const ENV_LIMITS: &str = "PANEWEFT_LIMITS";

/// Collection settings read from the environment the collector set. `None` when collection is not enabled.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Staging {
    pub run_id: String,
    pub dir: PathBuf,
    pub attempt: u32,
}

pub fn staging_from_env() -> Option<Staging> {
    if std::env::var(ENV_COLLECT).ok()? != "1" {
        return None;
    }
    let run_id = std::env::var(ENV_RUN_ID).ok().filter(|id| !id.is_empty())?;
    let dir = PathBuf::from(std::env::var(ENV_STAGING_DIR).ok().filter(|dir| !dir.is_empty())?);
    let attempt = std::env::var(ENV_ATTEMPT).ok().and_then(|text| text.parse().ok()).filter(|n| *n >= 1).unwrap_or(1);
    Some(Staging { run_id, dir, attempt })
}

/// The limits this process captures under: the defaults, lowered by `PANEWEFT_LIMITS` when the collector set it.
pub fn limits_from_env() -> crate::Limits {
    let overrides = std::env::var(ENV_LIMITS).ok().and_then(|text| serde_json::from_str::<Json>(&text).ok());
    match overrides {
        Some(value) => crate::Limits::default().with_overrides(&value),
        None => crate::Limits::default(),
    }
}

/// Writes `value` to `path` through a temporary sibling and a rename, so a reader never sees half a document.
pub(crate) fn write_json(path: &Path, value: &Json) -> std::io::Result<()> {
    write_text(path, serde_json::to_string(value).expect("a JSON value serializes").as_bytes())
}

/// Writes `bytes` through a temporary sibling and a rename. The text of a graph is the text the bounded serializer counted.
pub(crate) fn write_text(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&temporary, bytes)?;
    std::fs::rename(&temporary, path)
}

/// Artifact writes must never mask a test result: a failure is reported on stderr and the run continues, and the host then counts
/// the missing record.
pub(crate) fn write_or_report(path: &Path, value: &Json) {
    report(path, write_json(path, value));
}

/// As `write_or_report`, for text that was already serialized.
pub(crate) fn write_text_or_report(path: &Path, text: &str) {
    report(path, write_text(path, text.as_bytes()));
}

fn report(path: &Path, outcome: std::io::Result<()>) {
    if let Err(error) = outcome {
        eprintln!("paneweft: could not write {}: {error}", path.display());
    }
}

/// Writes `<staging>/catalogue/<binary>.json` when `PANEWEFT_CATALOGUE=1`. Runs no example body.
pub fn export_catalogue_if_requested() {
    if std::env::var(ENV_CATALOGUE).ok().as_deref() != Some("1") {
        return;
    }
    let Some(staging) = staging_from_env() else { return };
    let binary = std::env::current_exe().ok().and_then(|path| path.file_stem().map(|stem| stem.to_string_lossy().into_owned())).unwrap_or_else(|| "binary".to_string());
    let safe: String = binary.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' }).collect();
    let part = crate::Catalogue::linked_part(&safe);
    write_or_report(&staging.dir.join("catalogue").join(format!("{safe}.json")), &part);
}
