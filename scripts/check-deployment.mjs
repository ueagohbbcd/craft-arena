#!/usr/bin/env node
/**
 * Cross-checks one deployment's participant roster across its Compose file and
 * match config, which are written separately and must agree on IDs, usernames,
 * URLs, token variables and networks.
 *
 *   node scripts/check-deployment.mjs --compose infra/compose.live.yaml \
 *     --match infra/match.live.template.json
 *
 * Exits non-zero and lists every mismatch. checkDeployment() is the library form.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";

/** `${NAME}`, `${NAME:-x}` or `${NAME:?msg}` → NAME; anything else → null. */
const variable = (value) =>
  typeof value === "string" ? (value.match(/^\$\{(\w+)/)?.[1] ?? null) : null;
const networksOf = (service) =>
  Array.isArray(service?.networks)
    ? service.networks
    : Object.keys(service?.networks ?? {});
const envOf = (service) => {
  const env = service?.environment ?? {};
  if (!Array.isArray(env)) return env;
  return Object.fromEntries(
    env.map((line) => {
      const i = String(line).indexOf("=");
      return i < 0 ? [line, ""] : [line.slice(0, i), line.slice(i + 1)];
    }),
  );
};

export function checkDeployment({ compose, match }) {
  const errors = [];
  const fail = (text) => errors.push(text);
  const services = compose.services ?? {};
  const external = match.live?.bridges === "external";
  const host = services["arena-host"];
  const hostEnv = envOf(host);
  const bridgeServices = [];

  if (host && networksOf(host).some((n) => n !== "backend"))
    fail(
      external
        ? `arena-host must be on the backend network only, not ${networksOf(host).join(", ")}`
        : "arena-host joins participant networks: use live.bridges external",
    );
  if (external) {
    const tokenEnv = match.live.sessionServer?.tokenEnv;
    if (host && !(tokenEnv in hostEnv))
      fail(`arena-host does not receive ${tokenEnv}`);
  }

  for (const p of match.participants ?? []) {
    const name = `participant-${p.id}`;
    const service = services[name];
    if (!service) {
      fail(`${name}: no Compose service`);
      continue;
    }
    const env = envOf(service);
    const nets = networksOf(service);
    if (nets.includes("backend"))
      fail(`${name}: must not join the backend network`);
    // Model endpoint. Without OPENAI_BASE_URL the participant uses its own Pi
    // profile and whatever network the operator gave it. A Compose service
    // behind the URL (the model relay) reaches outside, so it must stay off
    // the backend network where Minecraft and the arena host live.
    if (env.OPENAI_BASE_URL) {
      let modelUrl;
      try {
        modelUrl = new URL(env.OPENAI_BASE_URL);
      } catch {
        fail(`${name}: OPENAI_BASE_URL is not a URL`);
      }
      const relay = modelUrl && services[modelUrl.hostname];
      if (relay) {
        if (networksOf(relay).includes("backend"))
          fail(`${modelUrl.hostname}: a model endpoint must not join backend`);
        if (!networksOf(relay).some((n) => nets.includes(n)))
          fail(`${modelUrl.hostname}: shares no network with ${name}`);
      }
    }

    // Game bridge.
    let url;
    try {
      url = new URL(env.ARENA_BRIDGE_URL);
    } catch {
      fail(`${name}: ARENA_BRIDGE_URL is not a URL`);
      continue;
    }
    const bridgeToken = variable(env.ARENA_BRIDGE_TOKEN);
    if (external) {
      const bridgeName = url.hostname;
      const bridge = services[bridgeName];
      bridgeServices.push({ p, bridgeName, nets });
      if (!bridge) {
        fail(`${name}: bridge service ${bridgeName} does not exist`);
        continue;
      }
      const benv = envOf(bridge);
      if (benv.MF_USERNAME !== p.username)
        fail(
          `${bridgeName}: MF_USERNAME ${benv.MF_USERNAME} != match username ${p.username}`,
        );
      if (variable(benv.BRIDGE_TOKEN) !== bridgeToken)
        fail(
          `${bridgeName}: BRIDGE_TOKEN differs from ${name}'s ARENA_BRIDGE_TOKEN`,
        );
      if (String(benv.BRIDGE_PORT ?? "8080") !== (url.port || "80"))
        fail(`${bridgeName}: BRIDGE_PORT ${benv.BRIDGE_PORT} != ${url.port}`);
      if (benv.BRIDGE_SESSION !== "host")
        fail(`${bridgeName}: BRIDGE_SESSION must be host`);
      let hostUrl;
      try {
        hostUrl = new URL(benv.BRIDGE_HOST_URL);
      } catch {}
      if (
        hostUrl?.hostname !== "arena-host" ||
        hostUrl.port !== String(match.live.sessionServer?.port) ||
        hostUrl.pathname !== `/v1/participants/${p.id}/session`
      )
        fail(
          `${bridgeName}: BRIDGE_HOST_URL is not http://arena-host:${match.live.sessionServer?.port}/v1/participants/${p.id}/session`,
        );
      if (
        variable(benv.BRIDGE_HOST_TOKEN) !== match.live.sessionServer?.tokenEnv
      )
        fail(
          `${bridgeName}: BRIDGE_HOST_TOKEN is not the session server token`,
        );
      if (!networksOf(bridge).some((n) => nets.includes(n)))
        fail(`${bridgeName}: shares no network with ${name}`);
    } else {
      if (url.hostname !== "arena-host")
        fail(`${name}: internal bridges are served by arena-host`);
      if (Number(url.port) !== p.bridge?.port)
        fail(
          `${name}: bridge port ${url.port} != match bridge.port ${p.bridge?.port}`,
        );
      if (p.bridge?.tokenEnv !== bridgeToken)
        fail(`${name}: ARENA_BRIDGE_TOKEN is not match bridge.tokenEnv`);
    }
  }

  // Isolation: a participant's networks reach only its own bridge.
  for (const { p, nets } of bridgeServices)
    for (const other of bridgeServices)
      if (
        other.p !== p &&
        networksOf(services[other.bridgeName]).some((n) => nets.includes(n))
      )
        fail(`participant-${p.id} can reach ${other.bridgeName}`);
  return errors;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  const values = (flag) =>
    args.flatMap((a, i) => (a === flag && args[i + 1] ? [args[i + 1]] : []));
  const [composePath] = values("--compose"),
    [matchPath] = values("--match");
  if (!composePath || !matchPath) {
    console.error(
      "Usage: node scripts/check-deployment.mjs --compose FILE --match FILE",
    );
    process.exit(2);
  }
  const errors = checkDeployment({
    compose: parse(await readFile(composePath, "utf8")),
    match: JSON.parse(await readFile(matchPath, "utf8")),
  });
  for (const error of errors) console.error(error);
  if (errors.length) process.exit(1);
  console.log("Deployment roster is consistent.");
}
