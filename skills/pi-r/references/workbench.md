# pi-r workbench reference

## Structural design

Design and Contract Revision Modes expose project reads, `r_contract_propose`, `r_contract_draft_inspect`, sandboxed R execution, and bounded raw-data inspection. The contract owns inputs, constants, dependencies, function signatures, targets, generated outputs, and deliverables. It does not require complete function behavior. User-only `/r lock` validates and commits the generated scaffold.

## Iterative implementation

Implementation Mode permits provisional edits under `R/`, `tests/`, and `docs/`. Raw inputs, attached roots, `.pi/`, Git internals, the contract, `R/constants.R`, and generated Nix/targets files remain protected. General shell is unavailable.

Use ordinary living documentation—normally `docs/analysis-plan.md`—and synthetic tests for cohort, joins, coding, missingness, events, censoring, and output expectations. Unknowns may remain while prototyping; they must not be represented as approved conclusions.

`r_function_inspect` provides bounded Approved Function source. `r_function_edit` optionally performs a Tree-sitter body edit with syntax, formatting, signature, policy, stale-content, and provenance checks. It may be called directly; inspection is not an authority grant.

## R execution

`r_exec` accepts ordinary R code and optional `targets`, `retain`, and `output`. Failed calls roll back. Successful calls retain only named assignments. Use `r_inspect`, `r_status`, `r_clear`, and `r_reset` for transient objects. Use `r_data_inspect` when bounded structural evidence is preferable to row-level model access.

## Durable transitions

- `/r revise` and `/r lock`: structural topology only.
- `/r environment`: activate validated dependency changes.
- `/r publish`: commit fresh declared deliverables.
- `/r stop`: discard transient state and restore the launcher surface.

These commands remain user-only.
