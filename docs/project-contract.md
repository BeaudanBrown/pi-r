# Project contract and generated scaffold

A **Project Contract** is the machine-managed source of truth for a constrained analysis project. The version-1 shape is published as [`resources/project-contract.schema.json`](../resources/project-contract.schema.json); CLI validation also enforces semantic references and graph rules that JSON Schema cannot express.

See [`tests/fixtures/project-contract.yml`](../tests/fixtures/project-contract.yml) for a complete example.

## Contract rules

- Every approved function lists only required parameter names. Defaults and variadic arguments are not representable.
- Every target calls exactly one approved function. Its named arguments exactly match that function's parameters.
- Constants are canonical scalar strings, finite numbers, booleans, or null. An argument references either one target or one canonical constant; inline target literals are not representable.
- Target references must form an acyclic graph.
- Artifact kinds are `table`, `object`, and `file`. Table and object artifacts generate `format = "qs"`, which current `targets` implements with the maintained `qs2` package; file artifacts generate `format = "file"`.
- A controlled file target declares one exact writable project-local output through a string constant bound to a `path`, `output_path`, or `file_path` parameter. Target execution rejects canonical path escapes and tracked paths except for the same target's explicitly versioned deliverable.
- Dynamic patterns are optional and limited to `map` or `cross`. Every pattern dimension must also be a target argument. Static branching forms are not representable.
- Optional versioned `deliverables` bind a non-dynamic file target to its exact output path. Other file-target outputs are ignored exactly; see [Versioned deliverable publication](deliverable-publication.md).
- Contract, template, policy, and Nixpkgs revisions are pinned.
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

Their complete contents must match the contract. Each approved function also gets one `R/<name>.R` file. Only its body is implementation-owned; all bytes outside that Tree-sitter body range remain contract-owned.

The generated `pi-r.yml` is canonical JSON with a YAML extension. JSON is valid YAML 1.2, and this representation makes semantically identical input formatting converge to byte-identical locked contracts.

## CLI

```console
pi-r contract validate contract.yml
pi-r contract generate contract.yml path/to/new-project
pi-r contract check contract.yml path/to/project
```

All commands return the shared JSON envelope. Generation refuses to overwrite an existing output directory. Checking regenerates expected Machine-Owned Files in memory, checks function structure through Tree-sitter, and returns `DRIFT_DETECTED` with sorted paths when anything contract-owned differs.
