# Scoped Approved Function implementation

After `/r lock`, Implementation Mode replaces the contract proposal capability with two narrow tools:

- `r_function_inspect` accepts an Approved Function name and returns its locked signature, complete source, and a SHA-256 source digest.
- `r_function_edit` accepts that function name and digest plus either a complete body replacement or an exact body-local patch.

Neither tool accepts a path. The implementation path is derived from the locked Project Contract as `R/<function>.R`; functions absent from that contract are outside the capability. Built-in shell, edit, and write tools remain disabled.

## Validation and policy

Every candidate is created without mutating source, formatted with the pinned formatter, parsed by Tree-sitter and a fresh base-R process, and checked against the locked name and parameter list. Local named helpers and anonymous functions are valid inside an Approved Function body.

Policy version `pi-r-policy-v1` rejects:

- package loading or installation;
- `source()` and related source loading;
- `setwd()`;
- `::` and `:::` namespace operators; and
- explicit `data.frame`/tibble construction or conversion.

The policy walks parsed R expressions, including local functions and default expressions, rather than matching source text.

## Mutation and provenance

Call `r_function_inspect` immediately before editing and pass its `sourceHash` to `r_function_edit`. A stale digest, tracked source drift, invalid syntax, formatting failure, policy violation, or scope violation returns an actionable recoverable error. These failures create neither a file change nor a commit.

A successful edit atomically replaces only the Approved Function file and creates exactly one commit. The result contains the final formatted diff and commit hash. Commit trailers record:

- `Capability: r-function-body-edit-v1`;
- `Contract-Hash` and `Contract-Version`; and
- `Policy-Version`.

The Workbench Session persists the resulting HEAD before another scoped mutation can run.
