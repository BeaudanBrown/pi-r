---
name: pi-r
description: Operate the constrained pi-r R/targets workbench. Use when the user asks to design, implement, inspect, run, govern dependencies, or publish an analysis through /r.
license: MIT
compatibility: Linux/NixOS project in a Git working tree; pi-r extension must be loaded.
---

# pi-r workbench

The extension, not this skill, is the authority boundary. Never work around its active tool set or substitute general shell/edit operations for a rejected capability.

1. Ask the user to invoke `/r start [read-only-root ...]`; only the user controls `/r` commands and approvals.
2. In Design or Contract Revision Mode, inspect text through the exposed read tools and profile selected columns, keys, and schema pages in uncontracted CSV/TSV inputs through `r_data_inspect`, then propose one complete Project Contract with `r_contract_propose`. Supply only project decisions: Approved Functions declare signatures, user-approved purpose, and evidence-backed behavioral requirements but never bodies, and pi-r injects contract/template/policy versions plus the exact packaged Nixpkgs pin. Represent existing input files as Source File Targets with `source.constant`; represent generated files through the explicit `output` binding. Keep target names distinct from Approved Function names. Zero functions and targets are valid when the requested design is empty. Wait for user-only `/r lock`.
3. In Implementation Mode, first confirm the locked target names with `r_targets_list` and inspect required input columns through bounded data tools. Durable source changes go through `r_function_edit`: inspect all requested functions together, then inspect/use the current digest for each edit and implement only its locked purpose and requirements. Legacy unspecified functions require user-only `/r revise`. Pass only inner R statements—never the outer declaration, outer braces, or `::` namespace operators. Do not narrate complete bodies, hashes, or payloads before acting. Exploration goes through transactional `evaluate_r`: always provide explicit `targets` and `retain`, retaining only objects needed later. Inspect retained values with `r_object_inspect`; use `r_worker_clear` for temporary-only cleanup. Target execution returns the locked verification checklist; inspect current artifacts against every requirement before claiming completion. On the first non-retryable infrastructure error, stop changing candidate code and report it. Dependency-only changes use the governed environment workflow. If the request changes constants, signatures, functions, targets, outputs, or deliverables, state that user-only `/r revise` is required and wait; never claim to invoke it yourself.
4. For ambiguous packages, use bounded `r_dependency_scout`, then send one selectable candidate through `r_dependency_propose`. Only `/r environment` may approve activation.
5. Target runs never publish outputs. Only user-only `/r publish` may commit exact contract-declared deliverables.
6. Separate observations from domain decisions. Types, missingness, cardinality, and overlap are observations; column meaning, coding semantics, and duplicate-resolution rules require contract, source-documentation, or user evidence.
7. Treat structured failures as recoverable instructions. Failed evaluations roll back. Do not seek broader authority.

See [the operational reference](references/workbench.md) for phases and capability boundaries.
