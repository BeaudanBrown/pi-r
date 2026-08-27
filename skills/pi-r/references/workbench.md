# pi-r operational reference

## Inactive

Only `/r` is registered. No R-specific tool or runtime guidance is active. `/r start` requires a Git repository with an existing commit and moves work to the repository-local `pi-r/workbench` branch after safely stashing tracked changes.

## Design Mode

The active surface is read-only plus contract proposal, bounded raw CSV/TSV profiling, and transactional R evaluation/object-inspection/state-management capabilities. Use `r_data_inspect` before a target exists, `r_object_inspect` for explicitly retained worker objects, and `r_artifact_inspect` only for targets. `r_contract_propose` replaces one ignored draft. The proposal contains only project decisions; pi-r injects `contractVersion`, `templateVersion`, `policyVersion`, and the exact packaged Nixpkgs pin locally. Never invent revision, hash, or timestamp placeholders. User-only `/r lock` validates the draft again, previews semantic and generated-source changes, publishes the deterministic scaffold transactionally, and creates one provenance commit.

A semantically empty design is valid:

```json
{
  "project": { "name": "empty-analysis" },
  "dependencies": [],
  "constants": {},
  "functions": [],
  "targets": []
}
```

It generates required targets infrastructure ending in `list()`, without placeholder Approved Functions or targets.

Existing read-only inputs are Source File Targets and require no artificial producer function:

```json
{
  "constants": { "input_csv": "data/input.csv" },
  "targets": [
    {
      "name": "input_csv_file",
      "artifact": "file",
      "arguments": {},
      "source": { "constant": "input_csv" }
    }
  ]
}
```

They render with `format = "file"`, participate in invalidation, and cannot be Versioned Deliverables. Generated file outputs are explicit rather than inferred from parameter names:

```json
{
  "project": { "name": "report-analysis" },
  "dependencies": [],
  "constants": { "report_path": "output/report.csv" },
  "functions": [
    { "name": "write_report", "parameters": ["output_path"] }
  ],
  "targets": [
    {
      "name": "report",
      "function": "write_report",
      "artifact": "file",
      "arguments": {},
      "output": { "parameter": "output_path", "constant": "report_path" }
    }
  ]
}
```

The `output.parameter` must name an Approved Function parameter omitted from `arguments`; `output.constant` must name one safe project-relative string constant. Every other Approved Function parameter is bound exactly once through `arguments`. Any referenced upstream target must also be declared in the complete proposal.

## Implementation and Contract Revision Modes

General shell and mutation are unavailable. Approved Function bodies are the only source-edit scope. Compact batch inspection returns status without source or digests. If it reports a behavior blocker, stop implementation planning and request user-only `/r revise`. Otherwise inspect one function with a positive source limit and edit that function immediately; any intervening or parallel edit loses the inspection grant. `r_function_edit` accepts only statements from inside the body. Omit the outer declaration and braces; local helpers remain valid. Governed package functions are available without forbidden `::` namespace operators. For data.table dynamic column selection, use an explicit mechanism such as `.SDcols`, and validate required column names first. Target listing/execution/workspace recovery, artifact inspection, governed dependency proposals, bounded dependency research, and the persistent R worker are exposed as typed tools. Every `evaluate_r` call explicitly names target inputs and retained outputs; failed calls roll back and successful calls discard unretained assignments. Prefer `r_worker_clear` over a full reset when only temporary exploration state should be removed. Source and attached roots are read-only inside Bubblewrap execution.

Implementation Mode locks function/target topology. Dependency-only changes use `r_dependency_propose` and user-only `/r environment`. Topology or behavior changes require user-only `/r revise`, which seeds an ignored draft while committed source stays unchanged. In Revision Mode, use `r_contract_draft_inspect` overview for compact state and function detail only for focused questions: `topology.changed` reports an actual diff, while missing behavior fields remain distinct from genuine operator decisions. Record explicit answers through `r_behavior_decision_record`; its exact quote and message hash prevent a broad paraphrase from becoming authority. `r_function_behavior_propose` can update only existing functions' behavior while preserving topology. It records complete category rationales, structured high-risk decisions, and durable ledger-backed evidence, reports unresolved functions, and cannot approve the draft. `/r lock` rejects missing categories, evidence, and unresolved placeholders. `/r lock` publishes the revision while preserving bodies only when Approved Function names, signatures, purpose, requirements, review, evidence, and structured decisions did not change; `/r cancel-revision` returns to the unchanged locked contract.

Tool observations do not authorize domain assumptions: do not infer variable coding from names or choose an arbitrary duplicate-resolution rule without contract, source-documentation, or user evidence.

Each successful durable mutation creates one provenance commit. Environment activation restarts R and discards Transient State while preserving the targets cache. Generated target outputs remain uncommitted unless declared as Versioned Deliverables and approved through `/r publish`.

## Deactivation and recovery

User-only `/r stop` records an inactive session marker, stops transient R state, and restores the launcher's original active tool set. Pi-r also performs restoration when the Pi session shuts down. A provenance or workspace mismatch fails closed instead of restoring unsafe authority. Use `/r status` for the bounded Current-State HUD and recovery guidance.

Detailed project-facing documentation is packaged under the pi-r reference root and available in the source repository's `docs/` directory.
