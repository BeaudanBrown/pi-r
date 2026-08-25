# Constrained R Workbench

The constrained R workbench turns an approved analysis design into a reproducible targets project while separating machine-managed architecture from implementation work.

## Language

**Project Contract**:
The locked, machine-managed description of approved functions, constants, dependencies, targets, artifact kinds, and dynamic patterns.
_Avoid_: Config, project spec

**Machine-Owned File**:
A generated file whose complete contents must match the Project Contract and pinned template version.
_Avoid_: Boilerplate, generated helper

**Approved Function**:
A top-level R function whose name and required parameters are fixed by the Project Contract while its body remains implementable.
_Avoid_: Script, callback

**Artifact Kind**:
The persistence category of a target: table, object, or file.
_Avoid_: Format

**Source File Target**:
A file target that tracks one existing read-only input path from a Project Contract constant without an Approved Function producer. It participates in invalidation but is never a generated output or Versioned Deliverable.
_Avoid_: File output, file producer, raw-data deliverable

**Dynamic Pattern**:
A declared map or cross relationship that controls dynamic target branching; absence means an unbranched target.
_Avoid_: Static branching, iteration mode

**Contract Drift**:
A mismatch between the locked Project Contract and a Machine-Owned File or Approved Function signature.
_Avoid_: Dirty file, customization

**Workbench Session**:
Session-local constrained state tied to one canonical working directory, Git repository, dedicated branch, and HEAD.
_Avoid_: Workspace, environment

**Design Mode**:
The read-only Workbench Session phase in which only project-scoped and attached-root read/search tools are active.
_Avoid_: Plan mode, safe mode

**Read-Only Root**:
A canonical project or user-attached path under which Design Mode may read or search.
_Avoid_: Allowlist, mount

**Current-State HUD**:
The bounded runtime-only, agent-facing context projection maintained at the logical tail of every model context while a Workbench Session is active. It tells the agent its current Mode, authority, valid transition, contract/policy and environment state, approval state, R worker state, and relevant object inventory. It replaces rather than accumulates before each model call and is never the operator-facing TUI display.
_Avoid_: Operator Status Widget, dashboard, telemetry, status history

**Operator Status Widget**:
The human-facing TUI summary of the active Workbench Session. It may render selected Current-State HUD facts, but it is not model context and is not called a HUD.
_Avoid_: Current-State HUD, agent message, model state

**Contract Draft**:
The single ignored, machine-managed, schema-valid Project Contract proposal revised during Design Mode.
_Avoid_: Temporary config, model output

**Provenance Commit**:
The single deterministic commit that locks the approved Project Contract and its complete generated scaffold with contract, template, and policy identifiers.
_Avoid_: Checkpoint, save

**Implementation Mode**:
The post-lock Workbench Session phase in which target/function topology is locked, Approved Function bodies may become editable through scoped capabilities, and dependency-only changes use the governed environment workflow.
_Avoid_: Coding mode, write mode

**Contract Revision Mode**:
The user-entered Workbench Session phase that seeds an ignored Contract Draft from the locked Project Contract while leaving committed source unchanged. It permits topology revision until user-approved relock or cancellation.
_Avoid_: Automatic mode switch, unlocked implementation, environment change

**Scoped Mutation**:
One stale-safe replacement or exact patch confined to an Approved Function body, validated before one provenance commit.
_Avoid_: Edit, write

**Source Digest**:
The SHA-256 token returned by Approved Function inspection and required by a Scoped Mutation to reject stale source.
_Avoid_: Version, checksum

**Sandbox Runtime**:
The immutable minimal Nix-store `PATH` shared by every Bubblewrap R helper instead of inheriting inaccessible or mutable host profile commands.
_Avoid_: System PATH, host tools

**Persistent R Worker**:
The session-scoped Bubblewrap process that evaluates bounded temporary R code through framed responses while project and attached source remain read-only.
_Avoid_: REPL, R session

**Raw Data Inspection**:
Bounded read-only structure and row sampling for CSV/TSV inputs under a Read-Only Root before a contracted target exists.
_Avoid_: Artifact inspection, file dump

**Transient State**:
Non-durable assignments and explicitly loaded target objects held by the Persistent R Worker until reset, crash, lock, or shutdown.
_Avoid_: Workspace, cache

**Target Runner**:
The separate bounded Bubblewrap process that lists or executes contracted targets without trusting Persistent R Worker state or gaining source mutation authority.
_Avoid_: Shell, worker

**Failed Target Workspace**:
The `targets`-saved upstream state from one failed target, loadable only into Transient State for diagnosis.
_Avoid_: Checkpoint, durable workspace

**Artifact Envelope**:
The common bounded result describing a target-backed table, object, or file through identity, Artifact Kind, producer/status, requested facets, structure, warnings, and recoverable error.
_Avoid_: Dump, preview

**Observed Metadata**:
Cached Artifact Envelope observations tied to a `targets` data hash and invalidated when that hash changes.
_Avoid_: Target metadata, durable state

**Technology Policy**:
The versioned shared classification of required, preferred, allowed, and prohibited R packages by problem domain.
_Avoid_: Package list, recommendations

**Dependency Scout**:
A separate ephemeral research-only Pi process receiving one sanitized requirement, fixed constraints, and relevant Technology Policy while exposing only bounded primary-source HTTP retrieval and structured candidate submission.
_Avoid_: Sub-agent, package resolver, installer

**Environment Candidate**:
One ignored package-change transaction whose policy decision, pinned-Nixpkgs resolution, generated files, package loads, and immutable R runtime have been validated without changing the active environment.
_Avoid_: Draft flake, pending install

**Environment Activation**:
The user-approved publication of an Environment Candidate in one Provenance Commit followed by a Persistent R Worker restart while preserving the targets cache.
_Avoid_: Hot reload, package installation

**Versioned Deliverable**:
One exact Project Contract-declared file-target output eligible for explicit source-control publication while other generated outputs remain ignored.
_Avoid_: Artifact, target output

**Deliverable Publication**:
The user-approved, stale-safe staging of only changed current Versioned Deliverables in one deterministic Provenance Commit. Target execution never performs publication.
_Avoid_: Export, target run, automatic commit
