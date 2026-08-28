# Controlled target operations

Implementation Mode exposes three typed target capabilities without exposing a shell:

- `r_targets_list` returns the locked target declaration and current `targets` freshness metadata;
- `r_targets_run` runs explicit canonical names, or the complete contract only when `all=true`; and
- `r_target_workspace` loads one failed target workspace into the Persistent R Worker for diagnosis.

## Listing and freshness

The bounded target inventory combines the locked Project Contract with local `targets` metadata. Each entry includes the producer function, Artifact Kind, canonical arguments, Dynamic Pattern, freshness (`missing`, `outdated`, `current`, or `failed`), size/time metadata when available, and bounded warning/error text. Contracts are capped at 200 targets and model-facing JSON is capped at approximately 8 KiB. Every runner invocation also records its complete stdout and stderr under `.pi/tmp/pi-r-target-runs/`. When process-level stderr is non-empty, the result includes a bounded `diagnostics.stderrTail` so the root cause is visible without guessing which log to read.

## Explicit execution

`r_targets_run` requires both `names` and `all`:

- use one or more contracted names with `all=false`; or
- use an empty name list with `all=true` to deliberately request the full contract.

An empty implicit selection, mixed explicit/all selection, or unknown name fails before R starts. Execution uses `Rscript` from the generated project flake, not the persistent worker, and defaults to a ten-minute timeout. Callers may select a timeout from 1 to 1,800 seconds; cancellation kills the isolated process and retains its log.

The Bubblewrap runner mounts project and attached source read-only. Its local `_targets/` store and `/tmp` are writable. A file target may also write the exact project-local output path declared by its explicit Project Contract `output: { parameter, constant }` binding. Legacy locked contracts using an inferred path parameter remain readable. Canonicalization rejects traversal, symbolic or hard links, internal runtime paths, and tracked source. The sole tracked-path exception is the same target's contract-declared versioned deliverable. Execution may update those bytes but never stages or commits them; publication remains the user-only [`/r publish`](deliverable-publication.md) boundary.

A successful run also returns a deterministic verification checklist for every reachable produced target: producer purpose, locked behavioral requirements, Artifact Kind, and whether behavior is specified. The run does not claim those requirements passed; the agent must inspect each current artifact and compare it with every listed requirement before claiming implementation complete. Legacy unspecified behavior is reported explicitly.

Target runs use the generated pipeline's `workspace_on_error = TRUE`. A failure returns `TARGET_RUN_FAILED`, the failed target identity, a bounded message and traceback, recovery operations, target statuses, and the complete log path. Results remain structured rather than throwing away diagnostic metadata.

## Failed-workspace diagnosis

After a failed run, `r_target_workspace` accepts the canonical failed target identity returned by the runner, including a dynamic branch identity. It starts or reuses the generated-project Persistent R Worker and asks `targets` to load the saved workspace there without sourcing mutable code or loading undeclared packages. Upstream objects become temporary worker objects and persist across later `r_exec` calls.

Loading a workspace never changes source, target metadata, or Git history. A missing workspace returns `TARGET_WORKSPACE_LOAD_FAILED` with recovery guidance. A target run invalidates canonical target objects already held by the worker so later exploration cannot mistake stale target state for current metadata.

For current target outputs, prefer [Target-backed artifact inspection](artifact-inspection.md) before loading raw values into exploration.
