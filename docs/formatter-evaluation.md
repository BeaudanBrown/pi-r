# R formatter decision

Issue #3 requires formatting to occur before a scoped candidate is validated. The formatter is therefore part of the workbench policy rather than a user preference.

## Decision

Use [`styler`](https://styler.r-lib.org/) through `styler::style_text(..., strict = TRUE)` on the selected function body only.

The flake lock pins the complete formatter closure; the current package is `styler` 1.11.0. The CLI wrapper points directly to the Nix-provided `Rscript` and machine-owned [`R/style_body.R`](../R/style_body.R), so host R libraries cannot alter formatting.

Formatting only the selected body is intentional. Formatting the complete source file could rewrite code outside the approved edit scope, violating the scoped editor contract.

## Evaluation

The canonical verification gate checks:

- idempotence by applying the same unformatted replacement to both the original fixture and the first formatted candidate, then requiring byte-identical candidates;
- representative `data.table` syntax including `.()`, `get()`, `by`, and a named aggregate;
- ordinary calls and nested local helper functions; and
- successful Tree-sitter and fresh base-R parsing after formatting.

These checks are deterministic and use no model, credentials, network service, or confidential data.
