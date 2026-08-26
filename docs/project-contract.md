# Project contract and generated scaffold

A **Project Contract** is the machine-managed source of truth for a constrained analysis project. The version-1 shape is published as [`resources/project-contract.schema.json`](../resources/project-contract.schema.json); CLI validation also enforces semantic references and graph rules that JSON Schema cannot express.

See [`tests/fixtures/project-contract.yml`](../tests/fixtures/project-contract.yml) for a complete example.

## Contract rules

- Every Approved Function lists required parameter names plus a user-approved `purpose` and one or more behavioral `requirements`; bodies, defaults, and variadic arguments are not representable. Requirements record relevant missing-value, duplicate, coding, cohort, and output rules instead of leaving implementation to infer them from names or observed values. Legacy locked contracts without these fields remain readable but their functions cannot be edited until a user-approved Contract Revision supplies them.
- Every ordinary target calls exactly one Approved Function. Its named arguments plus any explicit generated-file output binding exactly match that function's parameters. Package calls such as `data.table::fread()` belong inside an Approved Function body, not directly in the target declaration.
- Constants are canonical scalar strings, finite numbers, booleans, or null. An argument references either one target or one canonical constant; inline target literals are not representable.
- Target references must form an acyclic graph.
- Artifact kinds are `table`, `object`, and `file`. Table and object artifacts generate `format = "qs"`, which current `targets` implements with the maintained `qs2` package; file artifacts generate `format = "file"`.
- A **Source File Target** tracks one existing read-only input through `source: { constant }`, uses empty `arguments`, and omits `function`, `output`, and `pattern`. It renders directly as `tar_target(name, PI_R_CONSTANTS$constant, format = "file")`, requires no artificial path-returning function, and cannot be a Versioned Deliverable. Paths may be project-relative or absolute beneath a user-attached Read-Only Root; contract lock resolves them canonically, requires them to exist, and rejects any generated-output collision.
- A generated file target declares one exact writable project-local output through `output: { parameter, constant }`. The parameter is omitted from ordinary arguments, belongs to the Approved Function, and receives the referenced safe project-relative string constant. Legacy locked contracts using inferred path-parameter names remain readable. Target execution rejects canonical path escapes and tracked paths except for the same target's explicitly versioned deliverable.
- Dynamic patterns are optional and limited to `map` or `cross`. Every pattern dimension must also be a target argument. Static branching forms are not representable.
- Optional versioned `deliverables` bind a non-dynamic file target to its exact output path. Other file-target outputs are ignored exactly; see [Versioned deliverable publication](deliverable-publication.md).
- Target names must differ from Approved Function names, preventing ambiguous commands and apparent self-dependencies.
- Zero Approved Functions and zero targets represent a semantically empty pipeline; generation still emits valid targets infrastructure ending in `list()` without placeholders.
- Contract, template, policy, and Nixpkgs revisions are pinned. The model-facing proposal omits these authority-owned values; pi-r injects versions and the exact Nixpkgs input used to package the workbench.
- Dependencies resolve only from pinned Nixpkgs. Optional `dependencyApprovals` entries record the domain, rationale, original policy status, and project/shared scope of reviewed choices; see [Governed R package environments](environment-governance.md).

## Generated ownership

Generation writes these **Machine-Owned Files**:

- `pi-r.yml`
- `.pi-r/manifest.json`
- `_targets.R`
- `R/constants.R`
- `flake.nix` and `flake.lock`
- `.envrc` and `.gitignore`

Generated pipelines enable `workspace_on_error`, allowing the controlled runner to retain failed target inputs for temporary diagnosis.

Their complete contents must match the contract. Each Approved Function also gets one `R/<name>.R` file whose initial body fails closed with `stop("Not implemented")`; unfinished functions are never silently generated as identity operations. Only its body is implementation-owned; all bytes outside that Tree-sitter body range remain contract-owned. Contract Revision preserves implemented bodies only when names, signatures, purpose, and requirements remain unchanged. New, signature-changed, or behavior-changed functions return to fail-closed stubs; deleted functions are removed.

The generated `pi-r.yml` is canonical JSON with a YAML extension. JSON is valid YAML 1.2, and this representation makes semantically identical input formatting converge to byte-identical locked contracts.

## CLI

```console
pi-r contract validate contract.yml
pi-r contract generate contract.yml path/to/new-project
pi-r contract check contract.yml path/to/project
```

All commands return the shared JSON envelope. Generation refuses to overwrite an existing output directory. Checking regenerates expected Machine-Owned Files in memory, checks function structure through Tree-sitter, and returns `DRIFT_DETECTED` with sorted paths when anything contract-owned differs.
