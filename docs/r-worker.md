# Persistent sandboxed R exploration

A Workbench Session exposes three structured exploration tools in Design and Implementation Modes:

- `evaluate_r` evaluates temporary code and names every target to load explicitly;
- `r_worker_status` lists current object names, origins, classes, and approximate serialized sizes; and
- `r_worker_reset` discards all transient state and reports how many objects were lost.

The worker starts lazily on the first evaluation. Assignments remain available across calls until reset, crash, contract lock, or session shutdown. Exploration never changes Git provenance or durable source.

## Runtime transition

Design Mode uses the standard R runtime bundled with pi-r. Locking the Project Contract stops any Design Mode worker and discards its transient objects. The next Implementation Mode evaluation resolves `Rscript` from the generated, contract-pinned project flake and starts a fresh worker there.

Each evaluation reloads project globals and constants under their canonical names. Target objects are removed between calls and only the target names in that call's `targets` field are read from the targets store. Temporary assignments use a child environment, so they persist without becoming project globals.

## Bubblewrap filesystem

The worker process runs inside Bubblewrap. The Nix store, minimal system runtime, canonical project root, and attached Read-Only Roots are mounted read-only. `/tmp` and the worker home are ephemeral and writable. The network remains available in version one, as required by the Workbench Session policy.

Consequently, exploratory code can read approved inputs and create temporary files but cannot mutate project or attached source. Shell, edit, and write capabilities remain unavailable to the model outside the worker.

## Structured bounded results

Evaluation returns separate fields for:

- a small JSON-safe value or a class/length/size summary;
- a bounded preview;
- warnings;
- messages;
- a recoverable structured R error; and
- the bounded current object inventory.

Model-facing output is capped at approximately 8 KiB. Protocol frames, values, conditions, previews, and inventories have independent limits to prevent an accidental data dump from expanding model context.

A worker crash fails the active request with `WORKER_CRASH` and explicitly reports transient-state loss. The next evaluation starts a clean worker and marks `transientStateLost`. Cancellation and timeout also stop the worker rather than leaving an uncontrolled evaluation running. Requests time out after 30 seconds; generated-environment resolution has a separate bounded startup timeout.
