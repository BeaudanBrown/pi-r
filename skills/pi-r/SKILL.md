---
name: pi-r
description: Operate the constrained pi-r R/targets workbench. Use when the user asks to design, implement, inspect, run, govern dependencies, or publish an analysis through /r.
license: MIT
compatibility: Linux/NixOS project in a Git working tree; pi-r extension must be loaded.
---

# pi-r workbench

The extension, not this skill, is the authority boundary. Never work around its active tool set or substitute general shell/edit operations for a rejected capability.

1. Ask the user to invoke `/r start [read-only-root ...]`; only the user controls `/r` commands and approvals.
2. In Design Mode, inspect through the exposed read tools and propose one complete Project Contract with `r_contract_propose`. Supply only project decisions: pi-r injects contract/template/policy versions and the exact packaged Nixpkgs pin. Represent file outputs through the explicit `output` binding documented in the operational reference; zero functions and targets are valid when the requested design is empty. Wait for user-only `/r lock`.
3. In Implementation Mode, use only the active typed tools. Durable source changes go through `r_function_edit`; exploration goes through `evaluate_r`; target execution and artifact inspection use their dedicated tools.
4. For ambiguous packages, use bounded `r_dependency_scout`, then send one selectable candidate through `r_dependency_propose`. Only `/r environment` may approve activation.
5. Target runs never publish outputs. Only user-only `/r publish` may commit exact contract-declared deliverables.
6. Treat structured failures as recoverable instructions. Do not seek broader authority.

See [the operational reference](references/workbench.md) for phases and capability boundaries.
