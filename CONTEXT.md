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
The bounded runtime-only agent context projection showing current phase, Git provenance, contract/policy and environment state, approval state, R worker state, and object inventory. It replaces itself before each model call and is distinct from the operator-facing TUI widget.
_Avoid_: Dashboard, telemetry, status history

**Contract Draft**:
The single ignored, machine-managed, schema-valid Project Contract proposal revised during Design Mode.
_Avoid_: Temporary config, model output

**Provenance Commit**:
The single deterministic commit that locks the approved Project Contract and its complete generated scaffold with contract, template, and policy identifiers.
_Avoid_: Checkpoint, save

**Implementation Mode**:
The post-lock Workbench Session phase in which the Project Contract is immutable and only Approved Function bodies may become editable through scoped capabilities.
_Avoid_: Coding mode, write mode

**Scoped Mutation**:
One stale-safe replacement or exact patch confined to an Approved Function body, validated before one provenance commit.
_Avoid_: Edit, write

**Source Digest**:
The SHA-256 token returned by Approved Function inspection and required by a Scoped Mutation to reject stale source.
_Avoid_: Version, checksum

**Persistent R Worker**:
The session-scoped Bubblewrap process that evaluates bounded temporary R code while project and attached source remain read-only.
_Avoid_: REPL, R session

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
