# Cross-module integration evidence

## Reproduce

From the project root, using Node 24 or newer:

    npm ci
    node --test tests/integration-pi.test.mjs
    npm test

`integration-pi.test.mjs` imports the installed `@earendil-works/pi-coding-agent` 1.1.0 implementation and starts an actual `AgentSession`. It uses a local HTTP server speaking OpenAI streaming completions. Provider and game inputs are local fixtures. Tests use isolated temporary profiles and in-memory Pi sessions, disable retry and compaction, and clean up processes, sockets, and HTTP servers.

## What is exercised

1. **Ordinary process IPC:** Pi calls the extension's real bash tool. Its Node child constructs the actual InboxClient from inherited connection settings and posts a normal observation. The observation and command output appear together in the next provider request. Exactly two main model requests occur: tool selection and continuation.
2. **Urgent batch release:** The fake provider emits two bash calls in one assistant message. One child posts a normal event, then a judgment request. Both managed waits return `running`, allowing the next main model request while the real children are held behind an explicit file gate. Releasing that gate lets them finish. Completion causes no unsolicited model call. At the next natural tool boundary, each unique completion output appears exactly once.
3. **Default steering semantics:** During a running bash wait, `session.steer(...)` queues input. The queued message appears after the child finishes. Early urgent return uses the extension’s managed wait implementation.
4. **Actual codemode nesting:** Pi's own `createCodemodeExtension()` invokes nested bash and intentionally filters its returned text. The nested tool event includes `parentToolCallId`. The nested caller receives the command’s real raw output and can intentionally filter it. Unrelated inbox observations survive filtering and are attached only at the outer codemode result; only that outer result enters model context.
5. **Bridge, image, Pi, and accounting seam:** A fixture authoritative bot feeds the actual authenticated HTTP capability bridge. The SDK receives a real SSE mirror and submits a control action back to that bot. The local mirror renderer makes a PNG while preserving an unknown column. A Pi image-bearing tool result reaches the next OpenAI request through the actual participant-scoped budget gateway. The local provider reports 15 tokens for each of two requests; both participant and team ledgers finish at 30.

The fake provider scripts tool choices. These tests verify execution and delivery contracts. Strategy quality requires live gameplay evaluation. The bridge fixture supplies controlled authoritative state.

6. **Published image tools:** The actual `world_minimap` extension is exercised both directly and through real codemode. Structured native-image blocks are forwarded with `image(block)`; the resulting model request passes the budget gateway in both modes.

7. **Packaged bootstrap and real CLI:** A child process launches `packages/pi-extension/bootstrap.mjs --print ...` with an isolated workspace and fake credentials for the explicit one-shot smoke test. Its generated profile starts the installed bundled Pi CLI, resolves `${OPENAI_API_KEY}` to the scoped fixture token, authenticates to the exact participant route, and loads both inbox and world-image extensions. The overridden bash declaration includes `wait_seconds`. The gateway receives the output limit from the shared model descriptor, replaces the upstream bearer token, charges reported usage, and the CLI exits successfully.

8. **Model-visible budget and clock feedback:** The gateway’s authenticated read-only snapshot distinguishes in-flight reservations from settled usage. A real Pi request is held behind occupied concurrency slots, then admitted: exact queue delay and participant/team state appear in the next natural tool context as host-sourced data. Response headers provide an admission snapshot; a bounded authenticated GET at the natural boundary replaces it with the current settled-plus-reserved snapshot when available. Labels distinguish both cases. Zero delay does not claim a queue wait. Budget feedback and configured match-clock context remain passive and create no extra model requests.

9. **Resident RPC lifetime:** The no-argument bootstrap starts the real Pi RPC process with one initial prompt. A managed background child stays alive after the model’s final answer; idle time makes no model request. Program-authored urgent IPC causes exactly one new inference in the same conversation. An actual authenticated semantic-bridge `/v1/match` route supplies host-clock context and, when its fixture state becomes ended, the resident runner exits successfully and reaps the child. The route remains readable until test teardown. Provider requests also verify the shipped AGENTS guidance, valid programming skill and its source path, codemode, and world tools. Match state comes from a fixture supplier.

10. **Urgent event during a final stream:** The local provider sends final-answer text but holds its stream open while actual IPC posts arrive. A real Pi session confirms it is streaming at arrival. An urgent judgment event causes exactly one continuation with the original conversation and one copy of the event; ordinary passive IPC at the identical boundary persists once without an extra model call. This exercises the final-stream race.

11. **Reference-cost rate feedback and privacy:** Real Pi requests pass through the cash-window gateway using a local fake provider. The fixture reports 1,000 prompt tokens including 600 cached tokens, 100 output tokens and 40 reasoning tokens already included in output. Reference pricing charges 400 uncached input, 600 cached input and 100 output exactly once. At the fixture rates, operator accounting reports the exact decimal reference cost while the model receives only category cost shares, current-window load, pre-wait projected excess ratio, queue delay and usage-quality metadata. A held cash-rate reservation blocks upstream dispatch until released; after admission the next natural Pi tool boundary reads authenticated `/budget` without another model invocation. Oversized single-window requests are rejected before any upstream call. Pi 1.1.0 skips its response-header hook on HTTP 429, so the actual error turn boundary performs one bounded authenticated budget read, persists ratio-only feedback, and does not retry or invoke the model. A separate real queued-request cancellation test verifies that an aborted request is not treated as quota rejection and causes no such GET. Gateway and Pi project a bounded public accounting schema: structured upstream usage/payment metadata excludes monetary extension fields, and budget feedback excludes operator prices, currency and cash limits. This is accounting-field projection, not arbitrary-text DLP: assistant content and tool arguments remain unchanged, and public ratios may permit inferences. The CLI test now explicitly accepts only authenticated POST completions and GET budget routes, rejecting unexpected traffic rather than ignoring it.

## Architectural constraints verified or reviewed

- Participant-written code chooses event meaning, urgency, bot tactics and coordination; the inbox extension delivers its reports.
- Urgent IPC changes waiting behavior without killing child processes. Cancellation and execution timeout are separate explicit mechanisms.
- Long-lived child execution and tool-result delivery have independent lifetimes. A completed result must be claimed only once.
- Codemode's nested tool text is not automatically model-visible. A top-level hook is necessary to preserve inbox delivery.
- The participant SDK has no raw Minecraft client. Semantic commands are authenticated and validated in the backend.
- Vision is verified end to end: a real Pi provider request contains the image and passes gateway validation.
- Real provider credentials remain on the trusted gateway side. The integration uses only invented fixture tokens.
- Cash figures are official-list-price reference accounting for operators, not asserted invoices. The structured budget feedback exposes current-window cost shares and rate pressure, and omits monetary totals, prices, cash-rate limits and cumulative-spending alerts. This does not sanitize arbitrary provider text or tool arguments.

## Limits and deployment gates

- This executor rejects Unix-domain socket binding with EPERM. Integration tests explicitly use authenticated loopback HTTP; the separate Unix IPC test skips only when that policy is observed. Unix socket permissions and behavior still require a host that permits binding.
- Compose topology and CLI paths receive static review; live container isolation and restricted egress remain operator acceptance checks.
- Real Minecraft matches, live map reset, game-server referee integration, combat, terrain navigation and GPU/browser-based Prismarine viewer capture remain deployment checks. Run a live smoke match alongside the fixture/plugin/unit tests.
- Bridge snapshots, image limits, participant budgets, model output caps, server protocol, world/map configuration, and actual provider vision support must be frozen consistently before a match. A custom provider may use fields or image formats outside the deliberately bounded gateway contract.
- Pi version is pinned. An upgrade requires rerunning these tests and reviewing event signatures, parallel execution, provider request shapes, codemode normalization, and shutdown behavior.

