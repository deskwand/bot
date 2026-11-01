# SDD ledger — plan: docs/superpowers/plans/2026-11-01-single-active-channel.md

Executor: inline (executing-plans), no subagents. Checkout: /Users/example/src/bot-single-active-channel, branch feat/single-active-channel.
BASE: 4c4e152 (main, plan commits only; no code changes yet).
Spec read: docs/superpowers/specs/2026-11-01-single-active-channel-design.md.

## Setup notes
- Baseline: `npx vitest run` → 28 files / 222 tests pass (log /tmp/baseline-tests.log).
- Env probe (tests/tmp-env-probe.test.ts, deleted after use): `version_metadata` binding IS supported by the vitest pool and yields a real per-run id; the test `env` object is mutable and the mutated value is visible to DO instances, so a test can create an independent DO instance with a different (immutable-at-construction) env fixture. No production hot-swap seam added.

## Pre-flight shared interfaces
- Task 1 produces `AdmittedMessage` (type only) + `parseActiveChannel`/`routeIdentity`; Task 2 consumes them for inbound gating, Task 4 tightens Butler input. No conflict: Task 1 defines types only, no Butler consumer changes.
- Task 1/3 both touch ChannelDO send/edit: Task 1 keeps legacy `send(to)/edit(to)` working via env selection while adding `sendCurrent/editCurrent`; Task 3 migrates Butler and deletes the legacy pair in one commit so each commit type-checks.
- Task 3 produces persisted `ChannelMessageRef` JSON; Task 4 consumes it to decide "approval already presented under this routeKey". Same JSON shape, defined in protocol.ts at Task 3.
