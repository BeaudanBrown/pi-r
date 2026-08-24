# Target-backed artifact inspection

Implementation Mode exposes one general `r_artifact_inspect` capability for contracted table, object, and file targets. It reads through the generated project environment inside a read-only Bubblewrap process and never grants raw filesystem or shell authority.

## Request

Every request names one contracted target and one or both bounded facets:

- `structure` describes shape and types; and
- `summary` adds aggregate table summaries.

Unknown targets and unknown, empty, or repeated facets fail before R starts. Model-facing JSON remains capped at approximately 8 KiB.

## Common envelope

All Artifact Kinds return the same top-level fields:

- `identity`: canonical target name and current `targets` metadata hash;
- `kind`: locked `table`, `object`, or `file` declaration;
- `producer`: Approved Function, canonical arguments, and Dynamic Pattern;
- `status`: `current`, `missing`, `stale`, or `failed`;
- `facets`: the requested observations;
- `structure` and optional `summaries`;
- bounded `warnings` and a stable recoverable `error`; and
- cache hit/key metadata.

Missing targets return `MISSING_TARGET`, stale targets return `STALE_TARGET`, and failed targets return `FAILED_TARGET`. Their recovery arrays point to `r_targets_run`, and failed artifacts additionally suggest `r_target_workspace`.

## Kind-specific structure

Table inspection returns dimensions, at most 100 column names and classes, truncation state, and `data.table` keys. It never returns rows. The optional summary facet reports per-column type and missing count; numeric columns additionally report finite minimum, maximum, and mean, while other columns report distinct-count metadata.

A target declared as `table` whose current value is not a `data.table` remains current and receives `DECLARED_TABLE_NOT_DATA_TABLE`. Inspection does not invalidate or rewrite target metadata.

Object inspection returns class, length, serialized size, and at most 100 member names without returning member values. File inspection returns bounded paths plus existence, directory, and size metadata.

## Metadata-hash cache

Successful current envelopes are cached under `.pi/tmp/pi-r-artifact-cache/`, keyed by target and requested facets. The inspector always reads current `targets` metadata first and serves a cache entry only when its stored target-data hash matches. A source/input change reports stale state; after rebuilding, the changed target hash forces a cache miss and atomically replaces the observation. Missing, stale, and failed envelopes are not cached.
