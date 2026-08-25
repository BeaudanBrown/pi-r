# Git-backed Workbench Sessions

The Pi extension exposes one command surface while inactive:

```console
/r start [read-only-root ...]
/r status
/r stop
```

## Start and resume

`/r start` requires the active working directory to be inside a Git repository with `HEAD`. Before changing branches it stashes tracked staged and unstaged changes with the message `pi-r: tracked changes before workbench start`; untracked files are left in place. It then creates or resumes the repository-local `pi-r/workbench` branch.

Each successful start appends a `pi-r-workbench-state` custom entry to the Pi session. This entry is TUI/session state and does not enter model context. It records the canonical working directory and project root, branch and full HEAD, phase, attached Read-Only Roots, policy/contract state, and bounded HUD fields.

On Pi session resume, the extension verifies the canonical working directory, repository root, branch, and HEAD before restoring the persisted constrained phase. Transient R state is never resumed. A mismatch fails closed with no active model tools. `/r status` repeats this verification. User-only `/r stop` stops Transient State, records an inactive marker so later session loads do not resume the workbench, clears the HUD, and restores the exact tool surface captured from the normal or lean launcher.

## Design Mode boundary

Design Mode activates built-in `read`, `grep`, `find`, and `ls`, the typed draft-only `r_contract_propose` tool, and the compact persistent R exploration tools. It disables shell and general mutation tools and independently blocks every tool call outside that compact set. Read/search paths are resolved through the filesystem before they are checked against the canonical project root and optional user-attached Read-Only Roots, preventing `..` and symlink escapes. See [Project Contract design and lock](design-lock.md) for the proposal tool and approval transaction.

Optional roots may be absolute or relative to the active working directory. Quote a root containing spaces.

When the session shuts down or is replaced, the extension restores the tool selection that preceded Design Mode. While inactive, it registers no model tool and injects no policy prompt. Only the `/r` command remains visible.

## Current-State HUD

The operator-facing TUI widget reports phase, branch and abbreviated HEAD, contract and policy state, editable-scope count, pending approval, and R worker state.

Separately, the extension projects one bounded `pi-r-live-state` message into the outgoing agent context before every model call. This Current-State HUD is never appended to session history: each projection removes an older projection and regenerates current phase, provenance, policy, environment, approval, worker, Transient State loss, and target-cache state. It includes at most 50 current object names, origins, classes, and approximate sizes without values, and remains below 4 KiB. Runtime inventory updates after evaluation, failed-workspace loading, target invalidation, reset, crash, contract lock, and resume. Inactive sessions project nothing.

Routine evaluation results therefore omit the repeated inventory; `r_worker_status` and `/r status` still provide explicit bounded object status. See [Persistent sandboxed R exploration](r-worker.md) for worker lifecycle and loss reporting. Both active phases expose [bounded raw data inspection](raw-data-inspection.md) for approved CSV/TSV inputs before a target exists. Implementation Mode additionally exposes [Controlled target operations](target-operations.md) through a separate runner that never trusts worker state, [Target-backed artifact inspection](artifact-inspection.md) for bounded structural observations, and [Governed R package environments](environment-governance.md) through isolated [bounded dependency research](dependency-scout.md), staged dependency proposals, and user-only `/r environment` approval. Generated outputs remain outside provenance until the user explicitly reviews contract declarations through [Versioned deliverable publication](deliverable-publication.md) and `/r publish`.
