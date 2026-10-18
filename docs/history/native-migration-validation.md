# Native runtime migration validation

This report records the final local validation for the bridge and SDK removal on 2026-10-18. The migration commit is recorded in Git history alongside this report.

## Test results

The complete `npm test` run finished before the final fixture-only corrections: 399 tests, 349 passed, 46 failed, and 4 were skipped (75.1 seconds). The log is `../npm-test-acceptance.log`. After that run:

- The pinned-server test was updated to inspect `MC_VERSION` in the native deployment manifests. `node --test tests/prepare-minecraft.test.mjs` passed 5/5.
- Two Pi bootstrap fixtures now provide the model prices required when the runner environment sets `ARENA_COST_PER_HOUR`. The affected actual-CLI bootstrap test passed 1/1 after its fixture correction.
- `npm run check`, `npm run format:check`, and `git diff --check` passed after the final edits. The complete suite was not rerun after those fixture corrections.

The earlier 46 failures divide as follows:

| Count | Cause | Disposition |
|---:|---|---|
| 35 | Direct attempts to create the Inbox Unix socket failed with `listen EPERM` in this execution environment. Affected direct Inbox, watchdog, Pi extension, and runtime-state tests. | Environment block; Unix-domain socket server creation is denied here. Production Unix socket behavior remains covered by tests when run in a permitted environment. |
| 7 | Pi integration tests failed downstream of the denied Inbox socket. Symptoms included invalid JSON from the socket error, missing Inbox messages, unexpected continuation counts, and fake-provider responses that arrived after client closure. | Cascades from the same environment block; not independent evidence of migration regressions. |
| 2 | Pi bootstrap fixtures supplied `ARENA_COST_PER_HOUR` through the inherited environment but omitted model list prices. | Pre-existing failures in `tests-baseline-repeat.log`; fixture now supplies explicit prices. The actual CLI case passed after correction; full suite not rerun. |
| 1 | `live resident waits for running...` observed the Pi child exit before host shutdown. | This same assertion failed in `tests-baseline-repeat.log` before migration. In the current run, Inbox socket startup was denied; the focused live test cannot validate the production host-end path in this environment. |
| 1 | Pinned-server test searched for the removed `MF_VERSION` setting. | Migration test drift; updated to validate `MC_VERSION`, and the five-test file passed. |

The direct Unix-socket failures were: `arena-watchdog.test.mjs` (watchdog urgent finding); `inbox-current.test.mjs` (current facts/task id); `inbox-delay.test.mjs` (pending-creation delay); `inbox.test.mjs` (Unix IPC semantics and out-of-process delivery receipts); `integration-pi.test.mjs` (normal program IPC, urgent parallel batch, codemode result filtering, both image relay cases, resident reaping); `pi-extension.test.mjs` (runtime task snapshot, wait overrides, hook coalescing, full state snapshot, compaction state, passive boundary, idle urgent, spend-limit boundary, no-session behavior, session changes, final-boundary urgent, program completion, idle reminder, queued inbox events, public-data notice, final-answer notice, unusable task directory, lost task manager, bash command validation, stalled-progress wait); and all four `request-recovery.test.mjs` actual resident RPC cases (transient, fatal, queued, background).

The seven IPC-dependent cascades were `integration-pi.test.mjs`: omitted bash wait budgets, queued steer, full runtime state after compaction, both bootstrap/profile relay startup cases, passive IPC during final response, and urgent IPC during final response. The two price-fixture failures and the host-end child-exit assertion are all also present in the repeated pre-migration baseline. The `MF_VERSION` assertion is the only failure among the 46 introduced by this migration's changed deployment contract; it has been corrected and its file now passes.

Baseline comparison: `tests-final.log` recorded 619 tests, 552 passed, 64 failed, and 3 skipped before migration. A repeated nearby baseline run (`tests-baseline-repeat.log`) recorded 609 tests, 542 passed, 64 failed, and 3 skipped. The latest full run had 220 fewer discovered tests, 18 fewer failures than the 619-test baseline, and one additional skip. The removed tests primarily asserted the retired bridge protocol, SDK facade, and SDK-only extensions; they are not equivalent coverage reductions for current runtime behavior. Native behavioral coverage was added or retained for runner lifecycle/cancellation, Minecraft compatibility, navigation and cancellation, combat target selection, observer events, chat forwarding, world observation, provisioning, participant session isolation, and example cleanup.

Some bridge-era behavior tests were intentionally replaced rather than retained verbatim: `combat-report.test.mjs` was retired with the SDK combat-report plugin and target selection/cancellation/Inbox reporting is covered by `fight-target.test.mjs`; `craft-quantities.test.mjs` asserted the removed `bot.craftItem` wrapper and the participant skill now documents Mineflayer's `recipesFor`/`craft` API; `navigate-defense.test.mjs` now exercises native bot path resumption and disconnect cancellation. `runtime-state.test.mjs` remains in the suite; its state projection assertions remain, while the old bridge snapshot integration case was removed. Observer and Pi coverage exercise the current native event/session path, subject to the Unix socket environment block above.

## Session boundary

Native modules read their session through the participant-scoped `ARENA_SESSION_URL`; they do not carry a bearer token. The URL is reachable on that participant's isolated container network and terminates at its login gate. Each gate admits only the configured participant identities, and session lookup is read-only and limited to the queried admitted character. It does not accept game actions. `tests/login-gate.test.mjs` checks that a different team's identity cannot read the participant's session. The trust boundary is therefore the per-participant network plus the login gate's identity allowlist, rather than a credential embedded in every native module.
