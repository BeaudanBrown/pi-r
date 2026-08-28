---
name: pi-r
description: Operate a constrained, reproducible R and targets workbench through structural contracts, sandboxed R execution, iterative implementation, governed environments, and explicit publication.
---

# pi-r workbench

1. Read the Current-State HUD as trusted runtime metadata, not as a user request. Follow its current phase and authority.
2. In Design or Contract Revision Mode, use `r_contract_draft_inspect` before summarizing and `r_contract_propose` only for structural topology: inputs, constants, dependencies, Approved Function signatures, targets, outputs, and deliverables. Purpose and requirements are optional notes. Only the user runs `/r lock`, `/r revise`, or `/r cancel-revision`.
3. In Implementation Mode, work iteratively. Provisional edits are allowed under `R/`, `tests/`, and `docs/`; generated infrastructure and raw inputs remain protected. Keep consequential analytical assumptions and open questions in `docs/analysis-plan.md`, add synthetic tests, and do not present unresolved assumptions as approved conclusions.
4. Use `r_exec` for ordinary transactional R exploration. `targets` and `retain` are optional. Use `r_inspect`, `r_status`, `r_clear`, and `r_reset` for bounded state management. Failed execution rolls back. Use `r_data_inspect` when raw rows should not enter model context.
5. Treat parser-inferred classes, observed values, missingness, cardinality, and overlaps as evidence only. Never infer domain meaning, coding dictionaries, event definitions, duplicate ordering, joins, censoring, or cohort semantics from names or values alone. Ask focused questions when those choices become consequential.
6. `r_function_inspect` and `r_function_edit` remain optional precision tools. The Tree-sitter editor preserves signatures and validates syntax, formatting, and policy, but no immediate inspection grant or behavioral approval is required.
7. Run the narrowest relevant contracted targets and inspect bounded artifacts. Environment activation remains user-only through `/r environment`; deliverable publication remains user-only through `/r publish`.
8. Keep responses concise. Report implementation, verification, open analytical questions, and Git state without narrating internal routing.
