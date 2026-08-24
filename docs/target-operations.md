# Controlled target operations

Implementation Mode exposes three typed target capabilities without exposing a shell:

- `r_targets_list` returns the locked target declaration and current `targets` freshness metadata;
- `r_targets_run` runs explicit canonical names, or the complete contract only when `all=true`; and
- `r_target_workspace` loads one failed target workspace into the Persistent R Worker for diagnosis.

## Listing and freshness

The bounded target inventory combines the locked Project Contract with local `targets` metadata. Each entry includes the producer function, Artifact Kind, canonical arguments, Dynamic Pattern, freshness (`missing`, `outdated`, `current`, or `failed`), size/time metadata when available, and bounded warning/error text. Contracts are capped at 200 targets and model-facing JSON is capped at approximately 8 KiB. Every runner invocation also records its complete stdout and stderr under `.pi/tmp/pi-r-target-runs/`.

## Explicit execution

`r_targets_run` requires both `names` and `all`:

- use one or more contracted names with `all=false`; or
- use an empty name list with `all=true` to deliberately request the full contract.

An empty implicit selection, mixed explicit/all selection, or unknown name fails before R starts. Execution uses `Rscript` from the generated project flake, not the persistent worker, and defaults to a ten-minute timeout. Callers may select a timeout from 1 to 1,800 seconds; cancellation kills the isolated process and retains its log.

The Bubblewrap runner mounts project and attached source read-only. Its local `_targets/` store and `/tmp` are writable. A file target may also write an exact project-local output path supplied by a string constant through an `output_path`, `file_path`, or `path` parameter. Canonicalization rejects traversal, symlink escapes, internal runtime paths, and tracked source. The runner never creates a Git commit.

Target runs use the generated pipeline's `workspace_on_error = TRUE`. A failure returns `TARGET_RUN_FAILED`, the failed target identity, a bounded message and traceback, recovery operations, target statuses, and the complete log path. Results remain structured rather than throwing away diagnostic metadata.

## Failed-workspace diagnosis

After a failed run, `r_target_workspace` accepts the canonical failed target identity returned by the runner, including a dynamic branch identity. It starts or reuses the generated-project Persistent R Worker and asks `targets` to load the saved workspace there without sourcing mutable code or loading undeclared packages. Upstream objects become temporary worker objects and persist across later `evaluate_r` calls.

Loading a workspace never changes source, target metadata, or Git history. A missing workspace returns `TARGET_WORKSPACE_LOAD_FAILED` with recovery guidance. A target run invalidates canonical target objects already held by the worker so later exploration cannot mistake stale target state for current metadata.

For current target outputs, prefer [Target-backed artifact inspection](artifact-inspection.md) before loading raw values into exploration.
