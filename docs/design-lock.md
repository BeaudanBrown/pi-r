# Structural Project Contract design and lock

Design Mode defines durable project topology rather than a complete analytical specification.

The typed `r_contract_propose` draft declares:

- project identity and pinned Nix source;
- source inputs and constants;
- Approved Function names and parameters;
- package dependencies;
- targets and their graph;
- generated file outputs; and
- publishable deliverables.

Function purpose and requirements are optional descriptive notes. Behavioral review matrices, exact-quote evidence, and structured decision ledgers are not required and do not gate implementation.

`r_contract_draft_inspect` returns a compact authoritative overview of project identity, dependencies, constants, functions, targets, deliverables, and whether structural topology changed. The ignored draft remains under `.pi/tmp/` until the user approves `/r lock` or cancels revision.

## `/r lock`

Lock validates source-file authority, package resolution, generated scaffold integrity, and sandboxed project R startup. It previews the structural contract and complete generated-source diff, then creates one provenance commit after interactive user confirmation.

Lock grants permission to begin provisional implementation; it does not claim that analytical behavior is complete or scientifically approved.

## Revision

User-only `/r revise` is required for structural changes: constants, inputs, dependencies, function names or parameters, targets, generated outputs, or deliverables. Documentation, tests, and function-body behavior evolve directly in Implementation Mode. `/r cancel-revision` discards the structural draft without changing committed source.
