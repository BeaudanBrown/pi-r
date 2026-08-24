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
The bounded status line showing phase, Git provenance, contract/policy state, editable scope count, approval state, and R worker state.
_Avoid_: Dashboard, telemetry

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
