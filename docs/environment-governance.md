# Governed R package environments

Pi-r treats package selection as a reviewed environment mutation rather than source editing or runtime installation. Project Contract dependencies resolve only from the contract's pinned Nixpkgs `rPackages`; CRAN/GitHub installation, custom derivations, `renv`, and `install.packages()` remain unavailable. When package identity is genuinely ambiguous, the optional [bounded dependency research scout](dependency-scout.md) may collect primary evidence without gaining any resolution, mutation, or approval authority.

## Technology policy

The packaged `resources/technology-policy-v1.json` registry classifies package choices as required, preferred, allowed, or prohibited for named problem domains. A project may propose an unregistered package, but it must record a rationale and an approval scope:

- `project` records a project-only decision in `dependencyApprovals`; or
- `shared` records the decision in the project and, for an unregistered package, atomically promotes an allowed entry to the user-level `technology-policy-overrides-v1.json` registry.

The shared registry defaults to `$XDG_CONFIG_HOME/pi-r/technology-policy-overrides-v1.json` (or `~/.config/pi-r/...`) and may be overridden with `PI_R_SHARED_POLICY_PATH`. Packaged policy remains immutable. Prohibited choices return rationale and alternatives; required choices cannot be removed for their registered domain.

The deterministic CLI seams are:

```console
pi-r packages policy PACKAGE DOMAIN
pi-r packages resolve CONTRACT PACKAGE...
```

Resolution converts canonical R dots to Nix R-package underscores, evaluates exact attributes against the pinned input, rejects broken or unavailable derivations, and returns bounded edit-distance candidates for unknown names. `PI_R_NIXPKGS_PATH` is a deterministic test/development override for an already available copy of the same pinned source.

## Proposal and approval

Implementation Mode exposes `r_dependency_propose` with one add/remove operation, package, problem domain, rationale, and `project` or `shared` scope. The capability:

1. verifies Workbench provenance and a clean tracked tree;
2. applies technology policy;
3. regenerates the candidate Project Contract, flake, lock, `_targets.R`, and manifest under ignored `.pi/tmp` staging;
4. resolves every internal and declared package against pinned Nixpkgs;
5. evaluates the candidate environment, parses `_targets.R`, loads every package namespace, and resolves its immutable `Rscript`; and
6. returns a bounded semantic/generated-file summary without changing tracked files, Git, the active runtime, or the Persistent R Worker.

Unknown, unavailable, prohibited, required-removal, evaluation, and package-load failures are recoverable and leave the previous environment active. Only one candidate exists; a later proposal replaces it atomically.

The user-only `/r environment` command revalidates the candidate, shows package versions and the complete generated-source diff, and asks for explicit confirmation. Cancellation preserves the candidate and active worker. Approval writes only:

- `.pi-r/manifest.json`;
- `_targets.R`;
- `flake.lock`;
- `flake.nix`; and
- `pi-r.yml`.

One provenance commit records capability, policy versions, and approval scope. Shared-policy promotion and project publication are one rollback boundary until the commit succeeds.

After the commit, pi-r activates the already realized immutable R wrapper and restarts the Persistent R Worker. Transient State is discarded and reported through the live Current-State HUD; the `_targets/` store is not removed. Package or source changes may still make target metadata stale, so the agent lists freshness and reloads only current required targets.

## Initial contract lock

Initial contract dependencies undergo the same pinned-Nixpkgs resolution, generated-flake evaluation, package namespace load, and target-file parse before semantic review. Prohibited dependencies fail before approval. Unregistered initial dependencies require a `dependencyApprovals` record in the reviewed Project Contract. Build or validation failure leaves tracked source, Git, and a running Design worker unchanged.
