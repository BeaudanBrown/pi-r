# Bounded raw data inspection

Design and Implementation Modes expose `r_data_inspect` for CSV and TSV inputs, distinct from target-backed `r_artifact_inspect` and worker-held `r_inspect`.

Each requested file must resolve beneath the canonical project root or an attached Read-Only Root. Traversal, symlink escapes, non-files, unsupported extensions, and files larger than 2 GiB are rejected before execution. Primary and comparison paths receive the same checks. Inspection runs without network access in deterministic Bubblewrap and cannot mutate source.

A request supplies:

- `path`;
- up to ten columns to summarize;
- `columnOffset` and `columnLimit` for schema pagination;
- an optional key; and
- an optional comparison path when key overlap is required.

The tool returns byte and row counts, one explicit schema page with `nextOffset`, whole-file summaries for requested columns—including explicit `nonMissingUnique`, `distinctIncludingMissing`, missing/blank counts, and bounded value/count `top` entries for numeric as well as categorical columns—missing requested names, key missingness/cardinality/duplicate-row count, and optional cross-file unique-key overlap. It never returns rows by default.

Schema classes are parser-inferred observations, not declared domain types. An all-missing CSV column may be inferred as logical even when authoritative documentation defines it as a date or code. Schema inference reads a bounded sample. Whole-file summaries load only explicitly selected columns; key and overlap operations load only the requested key. This keeps wide-file discovery bounded while avoiding manual `fread()` and repeated full-table loads.

`topComplete` appears with `top` and states whether all distinct values, including a separately marked `<missing>` entry when present, fit in the bounded list. Do not reverse-engineer ambiguous or apparently inconsistent tool fields; report the limitation instead.

Treat these results as structural observations. Column names do not establish domain meaning, coding conventions, censoring semantics, or an authorized duplicate-resolution rule. Obtain those decisions from source documentation, living project notes, tests, or the user.
