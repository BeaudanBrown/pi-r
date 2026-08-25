# Bounded dependency research scout

`r_dependency_scout` is an optional research-only capability for ambiguous R package discovery in Implementation Mode. It does not replace technology policy, pinned-Nixpkgs resolution, a dependency proposal, user approval, or environment activation.

## Parent request boundary

The parent model must provide only:

- an explicit 10–1,000 byte sanitized requirement;
- one short problem-domain label;
- the fixed `R` ecosystem;
- one or both supported Linux platforms; and
- up to five optional canonical package-name hints.

Pi-r rejects control characters and obvious paths, URLs, email identities, credential labels, and copied secret material. It adds only the locked Nixpkgs revision and the relevant versioned Technology Policy projection. It does not forward conversation messages, system prompts, Current-State HUD contents, object inventories, source, target output, attached roots, or workspace paths.

## Process isolation

Each invocation creates a fresh empty mode-0700 temporary working directory and starts a separate ephemeral Pi process. The child invocation uses:

- JSON/print mode and `--no-session`;
- no discovered extensions, skills, prompts, themes, or context files;
- no built-in tools; and
- exactly `scout_http_get` and `scout_submit` from the packaged `pi-r-dependency-scout.ts` extension.

The child therefore has no read, grep, find, shell, write, edit, Git, R, Nix, workspace, mutation, approval, or activation capability. Abort propagates to the child and the temporary directory is removed on success or failure. The runtime defaults to the current Pi executable; `PI_R_SCOUT_PI`, `PI_R_SCOUT_PI_ENTRY`, and `PI_R_SCOUT_EXTENSION` are explicit packaging/test seams.

## Research surface

`scout_http_get` permits at most eight ten-second HTTPS requests. Requests are limited to bounded text/JSON responses, three redirects, 100 KiB per response, and approved public source families:

- R Project/CRAN and Bioconductor registries;
- NixOS package metadata;
- upstream GitHub repositories; and
- primary R ecosystem documentation from R Project, tidyverse, r-lib, rOpenSci, and Posit.

Localhost, arbitrary domains, credentials in URLs, ports, binary downloads, and oversized responses are rejected. Fetched text is explicitly treated as untrusted evidence rather than instructions.

## Structured result and parent authority

The child must terminate through `scout_submit` with at most five unique canonical R identifiers. Each candidate contains:

- a bounded summary;
- one to four typed HTTPS evidence records;
- up to five compatibility notes; and
- up to five unresolved questions.

The report itself carries up to eight cross-candidate unresolved questions. The parent validates every field again, including evidence-host/source consistency. Missing or malformed structured submission is a recoverable failure.

After research, the parent independently classifies every identifier through current Technology Policy and resolves it against the locked project's exact Nixpkgs `rPackages`. Unknown candidates receive bounded typo suggestions; unavailable, broken, or prohibited candidates are marked `selectable: false`. No candidate is automatically selected.

To proceed, the parent model must call `r_dependency_propose` for one selectable candidate with a fresh rationale and approval scope. That existing deterministic workflow re-runs policy and pinned resolution, evaluates the generated environment, and leaves final activation to user-only `/r environment` approval.

Deterministic verification uses a fake isolated child and local pinned Nixpkgs. It requires no model, credentials, network, or confidential data.
