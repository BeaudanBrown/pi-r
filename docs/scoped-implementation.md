# Scoped Approved Function implementation

After `/r lock`, Implementation Mode replaces contract proposal with two narrow tools:

- `r_function_inspect` accepts 1–20 Approved Function names and returns each locked signature, behavioral specification, complete source, and SHA-256 source digest in one coherent result. Use a one-item array immediately before editing one function.
- `r_function_edit` accepts one function name and digest plus only statements from inside its body. Do not repeat the declaration or outer braces. Local named helpers and anonymous functions remain valid.

Neither tool accepts a path. Paths derive from the locked contract as `R/<function>.R`; absent functions remain outside authority. Scoped edit requests are internally serialized, so the model need not speculate about concurrent Git locks.

## Locked behavior

New Design and Revision proposals give every Approved Function:

- a domain `purpose`; and
- bounded user-approved `requirements`, including relevant missing-value, duplicate, coding, cohort, and output rules.

Inspection places those requirements beside the source and digest. A legacy function without them returns `behavior.specified = false` and cannot be edited. The agent must ask the user to enter `/r revise`; it must not infer rules from column names, observed values, or remembered conversation.

Changing purpose or requirements during Contract Revision invalidates the prior implementation and restores its fail-closed stub even when name and parameters are unchanged.

## Validation and policy

Every candidate is created without mutating source, formatted with the pinned formatter, parsed by Tree-sitter and a fresh base-R process, and checked against the locked name and parameters. Policy `pi-r-policy-v1` rejects package loading/installation, source loading, `setwd()`, namespace operators, and explicit data.frame/tibble construction or conversion.

Call `r_function_inspect` immediately before editing and pass its `sourceHash`. A stale digest, unspecified behavior, tracked drift, invalid edit shape or syntax, formatting failure, policy violation, scope violation, or runtime incompatibility creates neither a file change nor a commit.

A successful edit atomically replaces only that file and creates one commit. The model-facing result is concise: function, path, commit, and the locked checklist still requiring target execution and artifact inspection. The complete formatted diff remains in tool details rather than being duplicated into model context. Commit trailers record capability, contract hash/version, and policy version.
