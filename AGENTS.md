# Orquest Bridge guidance

## Scope

This repository builds a local Codex-to-Antigravity orchestration bridge and
observability dashboard. Read `IMPLEMENTATION_PLAN.md` before changing public
contracts, persistence, process execution, MCP behavior, or security policy.

## Continuation and handoff

- Start from `docs/handoff.md` and `docs/continuation-progress.md`; use
  `docs/README.md` to locate the current plans and historical reports.
- For dashboard changes, follow `docs/visual-validation.md`: isolated fixtures,
  real browser interactions, screenshots tied to acceptance criteria, and
  read-only DOM measurements where needed. Screenshots complement tests; they
  do not replace them or prove untested behavior.
- Keep sanitized, portable evidence under `docs/evidence/<delivery-id>/` and
  link it from the delivery report. Record untested cases and the exact next
  action; preserve existing changes and close only your own test resources.

## Non-negotiable safety rules

- Never add `--dangerously-skip-permissions` to an Antigravity invocation.
- Do not bind the daemon outside `127.0.0.1` by default.
- Do not construct commands with `shell: true` or string interpolation.
- Do not log credentials, tokens, cookies, or unredacted sensitive environment
  values.
- Do not auto-merge, push, deploy, run migrations, or delete broad paths.
- Treat all paths received from a client as untrusted until canonicalized.

## Development rules

- Use TypeScript strict mode and Zod schemas for all external boundaries.
- Keep MCP responses compact; use cursors for transcripts and diffs.
- Persist an event before publishing it to a client.
- Maintain compatibility with Windows process execution.
- Keep the dashboard usable without JavaScript-heavy third-party UI kits.
- Use `npm.cmd` in this repository on Windows because `npm.ps1` is blocked by
  the local PowerShell execution policy.

## Required verification

Run the relevant commands before handing over changes:

```text
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
```

