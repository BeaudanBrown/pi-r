# Constrained R Workbench

The constrained R workbench turns an approved analysis design into a reproducible targets project while separating machine-managed architecture from implementation work.

## Language

**Project Contract**:
The locked, machine-managed description of approved functions, constants, dependencies, targets, artifact kinds, and dynamic patterns.
_Avoid_: Config, project spec

**Machine-Owned File**:
A generated file whose complete contents must match the Project Contract and pinned template version.
_Avoid_: Boilerplate, generated helper

**Approved Function**:
A top-level R function whose name and required parameters are fixed by the Project Contract while its body remains implementable.
_Avoid_: Script, callback

**Artifact Kind**:
The persistence category of a target: table, object, or file.
_Avoid_: Format

**Dynamic Pattern**:
A declared map or cross relationship that controls dynamic target branching; absence means an unbranched target.
_Avoid_: Static branching, iteration mode

**Contract Drift**:
A mismatch between the locked Project Contract and a Machine-Owned File or Approved Function signature.
_Avoid_: Dirty file, customization
