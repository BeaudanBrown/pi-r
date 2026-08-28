# Sandboxed transactional R execution

Pi-r exposes one small worker interface:

- `r_exec` evaluates ordinary R code transactionally;
- `r_inspect` returns bounded structure and summaries for a retained object;
- `r_status` reports worker state and object inventory;
- `r_clear` removes retained temporary objects; and
- `r_reset` restarts the worker and reports transient-state loss.

## `r_exec`

Only `code` is required. `targets` may name existing pipeline artifacts to load, and `retain` may name assignments to preserve after success. `output` selects compact structured or bounded console-oriented reporting.

The worker parses the complete expression, constructs deterministic project context, clones temporary bindings into a staged environment, and evaluates there. Failure commits nothing. Success commits only names listed in `retain`; all other new or modified assignments are discarded. Structured results, warnings, messages, and state changes are bounded before entering model context.

## Sandbox

The persistent process runs through Bubblewrap with immutable Nix-store tools, no network namespace, a read-only project and attached roots, and temporary writable storage. This protects the host and durable project state. It does not by itself guarantee that an expression cannot print a small sensitive value; use `r_data_inspect` when row-level data must stay out of model context.

The project R environment is distinct from editor R. Design Mode uses the packaged runtime; contract lock and environment activation restart the worker in the generated project runtime. Worker state is always transient and is discarded on reset, crash, lock, activation, stop, or incompatible resume.

Responses use explicit `PI_R_RESPONSE:` framing, and complete logs remain under `.pi/tmp/pi-r-worker/` with mode `0600`.
