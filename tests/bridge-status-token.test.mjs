import test from "node:test";
import assert from "node:assert/strict";
import { startBridge } from "../packages/mf-bridge/index.mjs";
import { cliOptions } from "../packages/mf-bridge/cli.mjs";
import { fakeBot } from "./bridge.test.mjs";

const token = "full-control-token-123";
const statusToken = "read-only-status-token";

test("the status token reads the session and nothing else", async (t) => {
  const b = fakeBot();
  const service = await startBridge({
    bot: b,
    token,
    statusToken,
    snapshotRadius: 1,
    getMatchState: () => ({ state: "running" }),
  });
  t.after(() => service.close());
  const as = (value, path, init = {}) =>
    fetch(`${service.url}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${value}`, ...init.headers },
    });
  const session = await as(statusToken, "/v1/session");
  assert.equal(session.status, 200);
  assert.deepEqual((await session.json()).result, { state: "running" });
  const action = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "setControlState",
      args: { control: "forward", state: true },
    }),
  };
  assert.equal((await as(statusToken, "/v1/action", action)).status, 401);
  assert.equal(b.calls.length, 0);
  for (const path of ["/v1/chunk?x=0&z=0", "/v1/memory/block?x=0&y=0&z=0"])
    assert.equal((await as(statusToken, path)).status, 401, path);
  const events = await as(statusToken, "/v1/events");
  assert.equal(events.status, 401);
  // The full token still does everything.
  assert.equal((await as(token, "/v1/action", action)).status, 200);
  assert.equal((await as(token, "/v1/session")).status, 200);
});

test("the status token must be long and distinct from the bridge token", async () => {
  for (const bad of ["short", token])
    await assert.rejects(
      startBridge({ bot: fakeBot(), token, statusToken: bad }),
      /statusToken/,
    );
  const options = cliOptions({
    MF_HOST: "mc",
    MF_USERNAME: "bot",
    MF_VERSION: "1.21.1",
    BRIDGE_TOKEN: token,
    BRIDGE_STATUS_TOKEN: statusToken,
  });
  assert.equal(options.bridge.statusToken, statusToken);
});
