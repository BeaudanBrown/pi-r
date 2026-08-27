# Scoped Approved Function implementation

After `/r lock`, Implementation Mode replaces contract proposal with narrow inspection and edit tools. The Operator Status Widget reports effective `scopes` separately from `behavior-blocked`; a legacy contract may run existing targets but exposes no edit capability when every function is blocked.

- `r_function_inspect` accepts 1–20 Approved Function names. `sourceLimit=0` returns compact status without source or digests and raises one top-level behavior blocker when applicable. Immediately before editing, request one behavior-specified function with `sourceOffset` and a source page of at most 3,000 characters.
- `r_function_edit` accepts that same function and digest plus only statements from inside its body. The runtime grants exactly one immediate inspect-to-edit sequence; another inspection or edit invalidates the prior grant. Edits must never be parallel. Do not repeat the declaration or outer braces. Local named helpers and anonymous functions remain valid.

Neither tool accepts a path. Paths derive from the locked contract as `R/<function>.R`; absent functions remain outside authority. Scoped edit requests are internally serialized, so the model need not speculate about concurrent Git locks.

## Locked behavior

New Design and Revision proposals give every Approved Function:

- a domain `purpose`;
- bounded user-approved `requirements`;
- a rule or not-applicable rationale for every behavior-review category; and
- durable user-decision, authoritative-source, or project-policy evidence.

Inspection places those requirements beside a single-function source page and digest. Compact inspection omits digests so it cannot authorize edits. A legacy function returns one `BEHAVIOR_UNSPECIFIED` blocker and cannot be edited. The agent must stop implementation planning and ask the user to enter `/r revise`; it must not inspect data, draft bodies, or turn names, observed values, remembered conversation, or a generic implementation request into behavioral approval.

Changing purpose, requirements, review, or evidence during Contract Revision invalidates the prior implementation and restores its fail-closed stub even when name and parameters are unchanged.

## Validation and policy

Every candidate is created without mutating source, formatted with the pinned formatter, parsed by Tree-sitter and a fresh base-R process, and checked against the locked name and parameters. Policy `pi-r-policy-v1` rejects package loading/installation, source loading, `setwd()`, namespace operators, and explicit data.frame/tibble construction or conversion.

Call a positive-source, one-function `r_function_inspect` immediately before each edit and pass its `sourceHash`. A stale digest, unspecified behavior, tracked drift, invalid edit shape or syntax, formatting failure, policy violation, scope violation, or runtime incompatibility creates neither a file change nor a commit.

A successful edit atomically replaces only that file and creates one commit. The model-facing result is concise: function, path, commit, and the locked checklist still requiring target execution and artifact inspection. The complete formatted diff remains in tool details rather than being duplicated into model context. Commit trailers record capability, contract hash/version, and policy version.
