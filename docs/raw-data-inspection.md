# Bounded raw data inspection

Design and Implementation Modes expose `r_data_inspect` for CSV and TSV inputs that do not yet have contracted targets. This is intentionally distinct from `r_artifact_inspect`, whose Artifact Envelopes always describe target-backed values.

The requested file must resolve beneath the canonical project root or an explicitly attached Read-Only Root. Traversal, symlink escapes, non-files, unsupported extensions, and files larger than 2 GiB are rejected before execution. Inspection runs without network access in the shared deterministic Bubblewrap runtime and cannot mutate source.

The tool reads at most 1,000 rows and returns a bounded structure: byte size, sampled row count, column names/classes, sampled missing counts, up to ten rows, and whether the sample limit was reached. Use it to understand an input before proposing the target graph. Use `evaluate_r` for temporary computations and `r_artifact_inspect` after a contracted target exists.
