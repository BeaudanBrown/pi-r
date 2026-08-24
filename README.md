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

The extension resource can be tried with Pi using the `extension` path reported above. It currently contributes only the inactive `/r` command surface; constrained workbench behavior is implemented in subsequent issues.

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

Enter the development environment and run the canonical gate:

```console
nix develop
nix run .#verify
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for issue lifecycle, Nix-only verification, confidentiality, and Git safety guidance.
