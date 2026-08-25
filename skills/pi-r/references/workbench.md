# pi-r operational reference

## Inactive

Only `/r` is registered. No R-specific tool or runtime guidance is active. `/r start` requires a Git repository with an existing commit and moves work to the repository-local `pi-r/workbench` branch after safely stashing tracked changes.

## Design Mode

The active surface is read-only plus contract proposal and bounded R exploration/status/reset capabilities. `r_contract_propose` replaces one ignored draft. User-only `/r lock` validates the draft again, previews semantic and generated-source changes, publishes the deterministic scaffold transactionally, and creates one provenance commit.

## Implementation Mode

General shell and mutation are unavailable. Approved Function bodies are the only source-edit scope. Target listing/execution/workspace recovery, artifact inspection, governed dependency proposals, bounded dependency research, and the persistent R worker are exposed as typed tools. Source and attached roots are read-only inside Bubblewrap execution.

Each successful durable mutation creates one provenance commit. Environment activation restarts R and discards Transient State while preserving the targets cache. Generated target outputs remain uncommitted unless declared as Versioned Deliverables and approved through `/r publish`.

## Deactivation and recovery

User-only `/r stop` records an inactive session marker, stops transient R state, and restores the launcher's original active tool set. Pi-r also performs restoration when the Pi session shuts down. A provenance or workspace mismatch fails closed instead of restoring unsafe authority. Use `/r status` for the bounded Current-State HUD and recovery guidance.

Detailed project-facing documentation is packaged under the pi-r reference root and available in the source repository's `docs/` directory.
