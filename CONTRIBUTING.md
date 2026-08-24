# Contributing

## Choose work

Work is planned in GitHub Issues. Select issues labeled `ready-for-agent` only when they have no open blockers. Use `ready-for-human` when a decision or manual action is required, `needs-info` when the specification is incomplete, and `needs-triage` for newly reported work that has not been assessed.

Link implementation changes to their issue. Never include confidential project data in an issue, commit, fixture, or test output.

## Develop and verify

Enter the reproducible environment with:

```console
nix develop
```

Run the one canonical repository gate before handoff:

```console
nix run .#verify
```

Verification is Nix-only and deterministic. Do not substitute host-installed Node or R commands. Smoke tests must not call a model, access credentials, use confidential data, or require a network service.

## Git lifecycle

Keep changes scoped to one issue and leave the working tree understandable. Agents must not push a commit or branch unless the user explicitly asks them to push. Avoid force-pushing or otherwise rewriting shared history.
