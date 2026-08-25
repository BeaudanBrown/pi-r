# Pi launcher integration

Pi-r is implemented in this repository and distributed as immutable resources. Pi-harness consumes those resources without copying extension logic.

## Stable Nix interface

`packages.<system>.pi-r.resourcePaths` exposes:

- `root`, `extension`, and `scoutExtension`;
- `skill`, `reference`, and packaged `docs`;
- `cli` and the pinned `rscript` runtime;
- `formatter`;
- `parser`, `parserGrammar`, and `parserQuery`;
- `sandbox`;
- `worker`, `targetRunner`, `artifactInspector`, and `contractReader`;
- `technologyPolicy`; and
- the exact `nixpkgs` source used for deterministic dependency resolution.

The package also exposes `passthru.piResources` for generic Nix consumers. Paths are Nix-store identities rather than mutable checkout paths.

## Normal Pi

Pi-harness loads only `resourcePaths.extension` alongside its normal resources and exports the runtime paths. While inactive, pi-r registers only `/r`: it does not register R tools, load the pi-r skill, append system guidance, or add live-state context.

After user-only `/r start`, pi-r captures the launcher's current tools before dynamically registering workbench tools and replaces the active surface with the phase-specific constrained set. User-only `/r stop` records an inactive marker, discards Transient State, clears the HUD, and restores that exact captured surface. Unsafe provenance drift fails closed instead of restoring authority.

## Lean local Pi

Pi-harness packages a separate `pi-r-local` launcher adapter around raw Pi. The distinct name lets a host-owned `pi-local` command retain model/configuration setup and delegate without a package collision. It uses `--no-extensions`, `--no-skills`, and `--no-context-files`, then explicitly loads only:

- the pi-r main extension; and
- the compact pi-r skill/reference.

`PI_R_INITIAL_TOOLS` establishes the lean inactive surface at `session_start` without Pi's permanent `--tools` filter, allowing dynamically registered workbench tools to activate later. The default is `read,bash,edit,write,grep,find,ls`.

The consuming host continues to own its dedicated `PI_CODING_AGENT_DIR`, local provider/model files, model selection, thinking level, and compact base system prompt. It should execute the packaged wrapper rather than raw `pi`:

```nix
exec ${piHarnessPackage}/bin/pi-r-local \
  --model "local-llm/${localLlm.defaultModel}" \
  --thinking low \
  --system-prompt "You are a concise coding assistant…" \
  "$@"
```

The dependency scout inherits the dedicated Pi configuration directory and starts raw Pi with only its research extension. With a static local provider in that directory, it selects the same configured local provider/default model while receiving no parent conversation, workspace, context files, skills, or general tools.

## Cross-repository verification

Pi-harness's canonical `nix run .#verify` checks every stable path and runs real RPC-mode launch probes without a model call:

1. Normal Pi exposes `/r`, retains harness commands, and has no pi-r skill or R tools while inactive.
2. Lean Pi exposes `/r` and only the pi-r skill, with no general harness extension or skill.
3. `/r start` activates the exact Design Mode capability surface.
4. `/r stop` restores the exact normal or lean initial tools.
5. The inactive marker prevents later session restoration.

During coordinated development before a pi-r commit is available remotely, pi-harness can be checked without changing its lock file:

```bash
nix run --no-write-lock-file \
  --override-input pi-r path:../pi-r \
  .#verify
```
