# Real qex output

Captured from qex 0.33.0 on 2026-11-11 (`qex submit --json`, `qex wait --json`, `qex status --json`) for a job that succeeds
(`true`), one killed with `qex kill` (`sleep 60`: state `killed`, `exit_code` null, `signal` 15) and one that died of SIGSEGV
(`sh -c 'kill -SEGV $$'`: state `failed`, `exit_code` null, `signal` 11). Host paths, pids and the submitter chain are scrubbed; the keys, the
types and the values that matter are verbatim. `qex list --json --all` prints an array of the same record.

Exit codes of `qex wait` (qex help agents): 0 to 96 the job's own exit code; 98 a signal other than TERM/KILL ended the job; 125 a kill, a
cancel or a time limit stopped it. Without `--json`, `qex wait` prints a line of text, not JSON. `bin/qex-real` replays these files.
