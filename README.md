# pi-r

Constrained, phase-gated R and [`targets`](https://books.ropensci.org/targets/) workspace for Pi coding agents.

## Bootstrap surface

This repository currently provides the independently buildable foundation for later workbench capabilities:

- `pi-r`, a packaged Node CLI;
- `pi-resources`, the Pi extension and R runtime-helper resource tree;
- a Nix development shell; and
- one deterministic verification app.

No smoke test uses a live model, confidential data, credentials, or network service.

## Use

Run the CLI directly from the flake:

```console
nix run . -- --version
nix run . -- paths --json
```

Inspect the exported Pi resource paths:

```console
nix eval --json .#packages.$(nix eval --raw --impure --expr builtins.currentSystem).pi-r.resourcePaths
```

The extension resource can be tried with Pi using the `extension` path reported above. It exposes only `/r` while inactive. In a Git repository with a commit, start or inspect a constrained design session with:

```console
/r start [read-only-root ...]
/r status
```

Start stashes tracked changes, creates or resumes `pi-r/workbench`, and switches the model to project-scoped read/search tools plus the typed contract proposal tool. Optional roots are canonicalized and added as read-only attachments. Phase state is persisted in the Pi session; resume fails closed if the working directory, repository, branch, or HEAD changed. See [Git-backed Workbench Sessions](docs/workbench-session.md) for the lifecycle and security boundary.

After iterating on one ignored, machine-managed Project Contract draft, review and lock the semantic design and complete generated-source diff:

```console
/r lock
```

Confirmation writes the complete scaffold, creates one provenance commit, and enters Implementation Mode. See [Project Contract design and lock](docs/design-lock.md).

Implementation Mode exposes stale-safe Approved Function inspection and body replacement/exact patching. It preserves locked names and signatures, enforces the R policy, and creates one provenance commit per successful mutation without exposing shell or general write authority. See [Scoped Approved Function implementation](docs/scoped-implementation.md).

Both constrained phases expose bounded temporary exploration through a lazy, persistent R worker. Bubblewrap keeps project and attached source read-only while assignments persist in ephemeral state; contract lock restarts exploration in the generated project environment. See [Persistent sandboxed R exploration](docs/r-worker.md).

## Scoped R function tracer

Inspect top-level functions without changing a file:

```console
nix run . -- r-functions inspect path/to/functions.R
```

Request a replacement or exact patch using JSON:

```json
{
  "path": "path/to/functions.R",
  "function": "summarise_groups",
  "operation": {
    "kind": "patch",
    "oldText": "mean(x)",
    "newText": "median(x)"
  }
}
```

```console
nix run . -- r-functions edit request.json
```

The command returns a formatted and validated candidate in a JSON envelope; it never writes the source file. See [the formatter evaluation](docs/formatter-evaluation.md) for the pinned formatting policy.

## Contract-generated projects

Validate a YAML Project Contract, generate a new locked project, or check an existing scaffold for drift:

```console
nix run . -- contract validate contract.yml
nix run . -- contract generate contract.yml path/to/new-project
nix run . -- contract check contract.yml path/to/project
```

Generation creates the complete minimal Nix/targets scaffold without overwriting an existing directory. See [the Project Contract reference](docs/project-contract.md) for its schema, semantic rules, generated ownership, artifact formats, and dynamic patterns.

Enter the development environment and run the canonical gate:

```console
nix develop
nix run .#verify
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for issue lifecycle, Nix-only verification, confidentiality, and Git safety guidance.
