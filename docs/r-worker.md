# Persistent sandboxed R exploration

A Workbench Session exposes five structured exploration tools in Design and Implementation Modes:

- `evaluate_r` transactionally evaluates code, names every target to load, and names every object to retain;
- `r_object_inspect` returns bounded structure and selected-column summaries for a retained object;
- `r_worker_status` lists current object names, origins, provenance, classes, and approximate serialized sizes;
- `r_worker_clear` removes only temporary objects while preserving generated globals, target context, and the targets cache; and
- `r_worker_reset` discards all transient state, starts a fresh worker, probes its framed protocol, and reports object loss and environment health.

`/r start` first probes the exact bundled worker protocol before changing Git state. The session worker starts lazily on the first evaluation. Exploration never changes Git provenance or durable source.

## Transactional state

Every `evaluate_r` request includes `code`, `targets`, and `retain`. Pi-r parses the complete expression, constructs deterministic project context, clones existing temporary bindings into a staged environment, and evaluates there. A failed evaluation commits nothing. A successful evaluation commits only names listed in `retain`; all other new or modified assignments are discarded. The returned `stateDelta` identifies committed, discarded, or rolled-back state.

Retained objects remain available across calls until cleared, reset, crash, contract lock, environment activation, or session shutdown. Object inventory records deterministic creation and last-modification request IDs. Use `r_object_inspect` rather than rereading source data or writing R string-formatting code.

Design Mode uses the R runtime bundled with pi-r. Locking the Project Contract stops any Design Mode worker and discards its temporary objects. The next Implementation Mode evaluation resolves immutable `Rscript` from the generated project flake and starts a fresh worker there.

Each evaluation reconstructs project globals and constants under canonical names. Target objects exist only when explicitly named by that call's `targets` field. Failed-target workspaces loaded through `r_target_workspace` become retained temporary objects for diagnosis.

## Bubblewrap filesystem

The worker process runs inside Bubblewrap. The Nix store, minimal system runtime, canonical project root, and attached Read-Only Roots are mounted read-only. Its `PATH` contains only immutable runtime utilities. `/tmp` and the worker home are ephemeral and writable. The network remains available in version one, as required by Workbench Session policy.

Exploratory code can read approved inputs and create temporary files but cannot mutate project or attached source. Shell, edit, and write capabilities remain unavailable outside the worker.

## Structured bounded results

Evaluation returns:

- a small JSON-safe atomic value when applicable;
- a bounded type-aware result summary;
- a transactional state delta;
- warnings and messages;
- a recoverable structured R error; and
- worker startup and transient-loss status.

Lists are recursively summarized with entry/depth limits. Tables report dimensions, paginated schema, and explicitly selected summaries without rows. Strings, entry counts, columns, protocol frames, and model-facing JSON all have independent bounds.

The extension projects bounded object inventory through the non-persistent [Current-State HUD](workbench-session.md#current-state-hud). Routine tool results do not repeat that inventory. Model-facing output is capped at approximately 8 KiB; the live-state projection is capped at 4 KiB and 50 displayed objects.

Worker responses use explicit `PI_R_RESPONSE:` framing, so unexpected stdout becomes diagnostics rather than protocol JSON. Each process writes a mode-0600 log under `.pi/tmp/pi-r-worker/`. Crash errors and `r_worker_status` expose bounded diagnostic tails and the log path.

A crash fails the active request with a specific startup, exit, timeout, or protocol code and reports transient-state loss. The next evaluation starts clean. Cancellation and timeout stop the worker rather than leaving uncontrolled evaluation running.
