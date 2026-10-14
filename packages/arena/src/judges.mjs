import {
  MAX_FAILED_POLLS,
  readSession,
  runPhase,
  writeServerConfig,
} from "./server-protocol.mjs";

/**
 * Judges decide the match outcome for the live runner. Every judge has the
 * same shape:
 *
 * - `afterBridges()`: prepare work once every participant bot has spawned.
 * - `start()`: release the match on the judge's side.
 * - `poll()`: one reading while running; throws to end the match `map-fault`.
 * - `stop(reason)`: freeze and read the final state while the host is ending.
 * - `public()`: latest public data the server published, or null.
 */
export function createJudge(config, context) {
  const type = config.judge.type;
  if (type === "datapack") return datapackJudge(config, context);
  if (type === "none") return noJudge(context);
  throw new Error(`Unknown judge type ${type}`);
}

/** No judging: the session runs until the operator stops it. */
function noJudge({ host }) {
  return {
    type: "none",
    async afterBridges() {},
    async start() {},
    async poll() {
      await host().checkTimeout();
    },
    async stop() {},
    public: () => null,
  };
}

/**
 * Server protocol v1 over RCON: write `arena:config`, run the `#arena:*`
 * function tags and poll `arena:session` (see docs/GAME-MODES.md).
 */
function datapackJudge(config, { rcon, host }) {
  let failures = 0,
    published = null,
    prepared = false;
  const run = (phase) => runPhase(rcon, phase);
  const read = async () => {
    const session = await readSession(rcon);
    if (session.public) published = session.public;
    return session;
  };
  return {
    type: "datapack",
    async afterBridges() {
      await writeServerConfig(rcon, config, host().runId);
      await run("prepare");
      prepared = true;
      // Pick up public data published at prepare for the opening briefing.
      try {
        await read();
      } catch {}
    },
    async start() {
      await run("start");
    },
    async poll() {
      if (await host().checkTimeout()) return;
      // Only the operator ends an open session: the server there only
      // publishes data, so read failures and "ended" are recorded, not final.
      const open = config.session.kind === "open";
      let session;
      try {
        session = await read();
        failures = 0;
      } catch (e) {
        failures++;
        if (open) host().judgeError = `arena:session unreadable: ${e.message}`;
        else if (failures > MAX_FAILED_POLLS)
          throw new Error(`Server session unreadable: ${e.message}`);
        return;
      }
      if (host().state !== "running") return;
      if (session.state === "ended" && !open) await host().verdict(session);
      else host().report(session);
    },
    async stop(reason) {
      // A server-declared end is already final; anything else is frozen here.
      if (!prepared || reason === "judge-decision") return;
      let error;
      try {
        await run("stop");
      } catch (e) {
        error = e;
      }
      try {
        host().conclude(await read());
      } catch (e) {
        host().judgeError ??= `Final arena:session read failed: ${e.message}`;
        host().conclude({});
      }
      if (error) throw error;
    },
    public: () => published,
  };
}
