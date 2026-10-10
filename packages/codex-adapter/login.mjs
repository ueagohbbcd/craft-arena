#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { createCodexModels } from "./auth.mjs";
const path = resolve(process.argv[2] ?? "runtime/codex/auth.json");
const models = createCodexModels(path);
const abort = new AbortController();
process.once("SIGINT", () => abort.abort());
const rl = createInterface({ input: process.stdin, output: process.stdout });
try {
  await models.login(
    "openai-codex",
    "oauth",
    {
      signal: abort.signal,
      async prompt(prompt) {
        if (prompt.type === "select") {
          for (const option of prompt.options)
            process.stdout.write(`${option.id}: ${option.label}\n`);
        }
        return rl.question(`${prompt.message} `, {
          signal: prompt.signal ?? abort.signal,
        });
      },
      notify(event) {
        if (event.type === "auth_url")
          process.stdout.write(
            `Open this URL in your browser:\n${event.url}\n`,
          );
        else if (event.type === "device_code")
          process.stdout.write(
            `Open ${event.verificationUri} and enter ${event.userCode}\n`,
          );
        else if (event.message) process.stdout.write(`${event.message}\n`);
      },
    },
    { agentName: "craft-arena" },
  );
  process.stdout.write(`Saved trusted OAuth credentials to ${path}\n`);
} finally {
  rl.close();
}
