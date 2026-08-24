# Git-backed Workbench Sessions

The Pi extension exposes one command surface while inactive:

```console
/r start [read-only-root ...]
/r status
```

## Start and resume

`/r start` requires the active working directory to be inside a Git repository with `HEAD`. Before changing branches it stashes tracked staged and unstaged changes with the message `pi-r: tracked changes before workbench start`; untracked files are left in place. It then creates or resumes the repository-local `pi-r/workbench` branch.

Each successful start appends a `pi-r-workbench-state` custom entry to the Pi session. This entry is TUI/session state and does not enter model context. It records the canonical working directory and project root, branch and full HEAD, phase, attached Read-Only Roots, policy/contract state, and bounded HUD fields.

On Pi session resume, the extension verifies the canonical working directory, repository root, branch, and HEAD before restoring the persisted constrained phase. Transient R state is never resumed. A mismatch fails closed with no active model tools. `/r status` repeats this verification.

## Design Mode boundary

Design Mode activates built-in `read`, `grep`, `find`, and `ls`, the typed draft-only `r_contract_propose` tool, and the compact persistent R exploration tools. It disables shell and general mutation tools and independently blocks every tool call outside that compact set. Read/search paths are resolved through the filesystem before they are checked against the canonical project root and optional user-attached Read-Only Roots, preventing `..` and symlink escapes. See [Project Contract design and lock](design-lock.md) for the proposal tool and approval transaction.

Optional roots may be absolute or relative to the active working directory. Quote a root containing spaces.

When the session shuts down or is replaced, the extension restores the tool selection that preceded Design Mode. While inactive, it registers no model tool and injects no policy prompt. Only the `/r` command remains visible.

## Current-State HUD

The bounded HUD reports:

- phase;
- branch and abbreviated HEAD;
- contract and policy state;
- editable-scope count;
- pending approval; and
- R worker state.

`/r status` also reports bounded worker object names and approximate sizes. See [Persistent sandboxed R exploration](r-worker.md) for worker lifecycle and loss reporting. Implementation Mode additionally exposes [Controlled target operations](target-operations.md) through a separate runner that never trusts worker state and [Target-backed artifact inspection](artifact-inspection.md) for bounded structural observations.
