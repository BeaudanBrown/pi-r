# Project Contract design and lock

An active Design Mode exposes `r_contract_propose`. Its parameters are the complete Project Contract decision schema. Each call performs strict schema and semantic validation and, on success, atomically replaces the session's single draft at `.pi/tmp/pi-r-contract-draft.json`. Before proposing, the agent must identify behavior relevant to every function, ask the operator about unresolved decisions, and distinguish user decisions or authoritative documentation from observations. An implementation request is not behavioral approval.

The draft is excluded through the repository's local Git exclude file, so proposing or revising it does not alter committed source. Invalid proposals leave the previous valid draft intact and return the validator diagnostic.

## Review and approval

```console
/r lock
```

Lock first rejects any Approved Function lacking a purpose or at least one behavioral requirement; legacy contracts remain readable but cannot be relocked unchanged. It then displays `R:locking` progress while it revalidates the Workbench Session and draft, checks source authority, resolves packages, realises the exact Nix/R environment, loads namespaces, probes the sandboxed worker, and prepares the approval diff. Completion or cancellation reports elapsed time. The environment validation process reports its own immutable `Rscript` path, avoiding a second `nix develop` used only for runtime discovery.

Before asking for confirmation, lock rejects tracked source changes. The confirmation contains:

- Approved Function names, required parameters, purpose, and behavioral requirements;
- canonical constants;
- R package dependencies;
- the target dependency graph, Artifact Kinds, and Dynamic Patterns; and
- a bounded deterministic diff of every generated scaffold file.

Cancellation writes nothing and preserves the draft for revision.

On approval, pi-r writes the canonical contract and complete scaffold as one logical transaction. Any write, staging, or commit failure restores prior file contents and index state. A single commit named `Lock pi-r project contract` records contract hash, template version, and policy version trailers. No unrelated path is staged or committed.

A successful commit persists Implementation Mode with the new HEAD, locked contract state, effective editable count, and zero behavior-blocked functions. The proposal tool is removed from the active compact tool set; scoped implementation capabilities are introduced by the implementation workflow.
