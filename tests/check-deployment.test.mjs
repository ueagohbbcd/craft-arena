import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { checkDeployment } from "../scripts/check-deployment.mjs";

const load = async (path) => {
  const text = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
  return path.endsWith(".json") ? JSON.parse(text) : parse(text);
};
const deployments = {
  live: [
    "infra/compose.live.yaml",
    "infra/match.live.template.json",
    ["infra/budget.cash.live.example.json"],
  ],
  windows: [
    "infra/windows-local/compose.yaml",
    "infra/windows-local/match.direct-fire.json",
    [
      "infra/windows-local/budget.red.json",
      "infra/windows-local/budget.blue.json",
    ],
  ],
};
async function deployment(name) {
  const [compose, match, budgets] = deployments[name];
  return {
    compose: await load(compose),
    match: await load(match),
    budgets: await Promise.all(budgets.map(load)),
  };
}

test("shipped deployments have a consistent participant roster", async () => {
  for (const name of Object.keys(deployments))
    assert.deepEqual(checkDeployment(await deployment(name)), [], name);
});

test("roster mismatches and isolation breaks are reported", async () => {
  const cases = [
    [
      (d) => (d.match.participants[0].username = "someone_else"),
      /MF_USERNAME arena_red1 != match username someone_else/,
    ],
    [
      (d) =>
        (d.compose.services["bridge-red1"].environment.BRIDGE_TOKEN =
          "${BLUE1_BRIDGE_TOKEN}"),
      /bridge-red1: BRIDGE_TOKEN differs/,
    ],
    [
      (d) => d.compose.services["bridge-blue1"].networks.push("red1"),
      /participant-red1 can reach bridge-blue1/,
    ],
    [
      (d) => d.compose.services["arena-host"].networks.push("red1"),
      /arena-host must be on the backend network only/,
    ],
    [
      (d) => (d.budgets[0].participants.red1.team = "blue"),
      /red1: budget team blue != match team red/,
    ],
    [
      (d) =>
        (d.budgets[0].participants.red1.matchStatusUrl =
          "http://bridge-blue1:8080/v1/session"),
      /red1: budget matchStatusUrl/,
    ],
    [
      (d) =>
        (d.budgets[0].participants.red1.matchTokenEnv = "RED1_BRIDGE_TOKEN"),
      /holds the full bridge token/,
    ],
    [
      (d) => delete d.compose.services["participant-blue1"],
      /participant-blue1: no Compose service/,
    ],
    [
      (d) =>
        (d.compose.services["bridge-red1"].environment.BRIDGE_HOST_URL =
          "http://arena-host:9000/v1/participants/blue1/session"),
      /BRIDGE_HOST_URL is not http:\/\/arena-host:9000\/v1\/participants\/red1\/session/,
    ],
    [
      (d) => (d.match.live.sessionServer.port = 9100),
      /bridge-red1: BRIDGE_HOST_URL is not http:\/\/arena-host:9100/,
    ],
  ];
  for (const [mutate, expected] of cases) {
    const d = await deployment("live");
    mutate(d);
    const errors = checkDeployment(d);
    assert.ok(
      errors.some((e) => expected.test(e)),
      `${expected}: ${errors.join("; ")}`,
    );
  }
});
