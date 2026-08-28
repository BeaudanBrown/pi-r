# Project Contract

The Project Contract is the machine-managed declaration of durable project structure.

It contains:

- contract, template, and technology-policy versions;
- project identity and exact Nixpkgs pin;
- approved dependencies and dependency records;
- constants and source paths;
- Approved Function names and required parameters;
- target definitions, arguments, artifact kinds, and dynamic patterns;
- generated file outputs; and
- Versioned Deliverables.

Approved Function bodies are never part of the contract. `purpose` and `requirements` remain optional descriptive metadata for compatibility and navigation; they are not semantic authority and never block implementation. Historical behavior-review, evidence, and structured-decision fields remain readable in existing contracts but are deprecated and omitted from new model proposals.

## Structural authority

The contract protects topology that generated infrastructure and targets depend upon. Adding, removing, renaming, or changing a function signature, constant, source input, dependency, target, output, or deliverable requires Contract Revision and user-approved `/r lock`.

Function-body behavior, tests, and living analytical documentation evolve provisionally in Implementation Mode. Consequential decisions should be recorded in `docs/analysis-plan.md` and executable synthetic tests rather than duplicated into a lock schema.

## Source and output targets

An existing input is a Source File Target with `artifact: file` and `source.constant`; it does not call a function and cannot be a deliverable. A generated file target calls an Approved Function and binds its output parameter to a declared path constant. Versioned Deliverables name exact generated file targets and repository-relative publication paths.

## Validation

Contract validation checks canonical names, exact parameter bindings, target acyclicity, source/output separation, package records, deliverable eligibility, and canonical paths. Lock additionally validates the generated environment, scaffold, and sandboxed project worker before committing one provenance transaction.
