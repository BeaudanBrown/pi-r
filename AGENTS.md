# Contributor instructions

## Work tracking

- GitHub Issues are the source of truth. Implement only a ready, unblocked issue or work explicitly requested by the user.
- `ready-for-agent` means an issue is fully specified and can be selected by an agent.
- `ready-for-human` means work is waiting for a human decision or action.
- `needs-triage` and `needs-info` are not implementation-ready states.
- Keep issue and pull-request discussion free of confidential analysis data.

## Verification

- Use Nix-provided tools only; do not rely on globally installed Node, R, formatters, or test runners.
- Run the canonical deterministic gate with `nix run .#verify`.
- The gate must remain offline at test time: no live model, credentials, services, or confidential data.

## Git safety

- Do not push commits or branches unless the user explicitly requests a push.
- Do not rewrite published history.
- Report the verification and working-tree state when handing work back.
