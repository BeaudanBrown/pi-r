# Provisional implementation

After structural `/r lock`, Implementation Mode supports ordinary iterative engineering on the dedicated `pi-r/workbench` branch.

## Writable project areas

Built-in `edit` and `write` are available only under:

- `R/`;
- `tests/`; and
- `docs/`.

Raw tabular inputs, attached roots, `.git/`, `.pi/`, the locked contract, Nix/targets infrastructure, and `R/constants.R` remain protected. General shell remains unavailable. These edits are provisional working-tree changes for normal review; they are not automatically committed or published.

## Approved Functions

The Project Contract fixes Approved Function names and parameters. Descriptive purpose and requirements are optional notes and never block implementation. Use `r_function_inspect` when a bounded source page or stale-content digest is useful. `r_function_edit` remains an optional Tree-sitter-backed adapter that edits one body, validates syntax, formatting, signature, and R policy, and creates a focused provenance commit. It no longer requires an immediately preceding inspection.

For broader work, edit R, tests, and `docs/analysis-plan.md` together, then run the narrowest useful targets and inspect bounded outputs. Keep consequential assumptions and unresolved questions visible; do not present them as approved conclusions.

## Structural changes

Adding, removing, renaming, or changing signatures of Approved Functions—or changing constants, targets, dependencies, source inputs, or deliverables—still requires user-only `/r revise` and `/r lock`. Ordinary behavior, documentation, tests, and body iterations do not.
