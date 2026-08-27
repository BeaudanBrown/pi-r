# Git-backed Workbench Sessions

The Pi extension exposes one command surface while inactive:

```console
/r start [read-only-root ...]
/r status
/r stop
```

## Start and resume

`/r start` immediately displays `R:starting` progress while it checks the repository, attached roots, sandbox runtime, branch, locked scaffold, and worker health; the completion notice reports elapsed time. It requires the active working directory to be inside a Git repository with `HEAD`. Before changing branches it stashes tracked staged and unstaged changes with the message `pi-r: tracked changes before workbench start`; untracked files are left in place. It then creates or resumes the repository-local `pi-r/workbench` branch. A project without a locked contract enters Design Mode; a project with a valid locked contract checks scaffold integrity, resolves the already-approved project R runtime, and probes worker health before entering Implementation Mode. Start deliberately does not repeat the expensive package-resolution and namespace-validation transaction already completed by `/r lock` or `/r environment`; those approval operations remain responsible for full validation. Existing topology is revised only through user-only `/r revise`.

Each successful start appends a `pi-r-workbench-state` custom entry to the Pi session. This entry is TUI/session state and does not enter model context. It records the canonical working directory and project root, branch and full HEAD, phase, attached Read-Only Roots, policy/contract state, and bounded HUD fields.

On Pi session resume, the extension verifies runtime-state version, canonical working directory, repository root, branch, and HEAD before restoring the persisted constrained phase. A state created by an incompatible pi-r runtime fails closed and requires a fresh Pi session. Transient R state is never resumed. A mismatch fails closed with no active model tools. Pi-r retains the exact blocked reason in the Operator Status Widget and `/r status`, and injects a model instruction that no tools are available and remembered tool-call markup must not be emitted. `/r status` repeats this verification. User-only `/r stop` stops Transient State, records an inactive marker so later session loads do not resume the workbench, clears the HUD, and restores the exact tool surface captured from the normal or lean launcher.

## Design Mode boundary

Design Mode activates built-in `read`, `grep`, `find`, and `ls`, the typed draft-only `r_contract_propose` tool, and the compact persistent R exploration tools. Direct reads of CSV/TSV inputs are blocked in favor of `r_data_inspect`; in Implementation Mode broad searches that traverse a contract-declared raw tabular Source File Target are also blocked. It disables shell and general mutation tools and independently blocks every tool call outside that compact set. Read/search paths are resolved through the filesystem before they are checked against the canonical project root and optional user-attached Read-Only Roots, preventing `..` and symlink escapes. See [Project Contract design and lock](design-lock.md) for the proposal tool and approval transaction.

Optional roots may be absolute or relative to the active working directory. Quote a root containing spaces.

## Contract Revision Mode

Implementation Mode keeps target/function topology locked. When a request adds, removes, or renames constants, signatures, functions, targets, generated outputs, or deliverables, the agent recommends the exact user-only `/r revise` transition but cannot invoke it. Dependency-only changes remain in Implementation Mode through `r_dependency_propose` and `/r environment`.

`/r revise` verifies provenance and a clean tree, rejects pending environment/approval work, confirms Transient State loss, and seeds the ignored Contract Draft from the committed contract while leaving source unchanged. For behavior-only migration, `r_function_behavior_propose` updates purpose and requirements for existing functions while preserving topology; each update identifies its user-decision or authoritative-source basis and reports unresolved functions. The agent asks focused questions rather than inferring answers. `/r lock` rejects any unresolved behavior, previews the complete requirements, and transactionally commits the revision, preserving bodies only when signature and behavior are unchanged. `/r cancel-revision` discards the draft and restores the unchanged Implementation Mode runtime.

When the session shuts down or is replaced, the extension restores the tool selection that preceded the active mode. While inactive, it registers no model tool and injects no policy prompt. Only the `/r` command remains visible.

## Current-State HUD

The human-facing Operator Status Widget reports selected mode, provenance, contract, effective editable scopes, behavior-blocked functions, approval, and worker facts. It is not called the HUD.

The **Current-State HUD** is the agent-facing `<pi_r_current_state>` projection inserted into outgoing context before every model call. A stable system instruction identifies it as trusted extension metadata rather than user input and forbids answering, summarizing, acknowledging, or attributing it to the user. It is inserted before the latest genuine user request so assistant/tool-result ordering remains intact. The HUD is never appended to session history: each projection removes an older projection and regenerates current mode and agent duty, authority, valid user transition, runtime version, provenance, environment, approval, worker, Transient State loss, and target-cache state. It includes at most 50 current object names, origins, classes, approximate sizes, and deterministic creation/modification request IDs without values, and remains below 4 KiB. Runtime inventory updates after evaluation, failed-workspace loading, target invalidation, reset, crash, contract lock, and resume. A completion ending with `stopReason = length` adds a one-turn warning that the partial response is unsafe to assume complete; pi-r never auto-continues a truncated tool payload. Inactive sessions project nothing.

Routine evaluation results therefore omit the repeated inventory; `r_worker_status` and `/r status` still provide explicit bounded object status. See [Persistent sandboxed R exploration](r-worker.md) for worker lifecycle and loss reporting. Both active phases expose [bounded raw data inspection](raw-data-inspection.md) for approved CSV/TSV inputs before a target exists. Implementation Mode additionally exposes [Controlled target operations](target-operations.md) through a separate runner that never trusts worker state, [Target-backed artifact inspection](artifact-inspection.md) for bounded structural observations, and [Governed R package environments](environment-governance.md) through isolated [bounded dependency research](dependency-scout.md), staged dependency proposals, and user-only `/r environment` approval. Generated outputs remain outside provenance until the user explicitly reviews contract declarations through [Versioned deliverable publication](deliverable-publication.md) and `/r publish`.
