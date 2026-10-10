import {
  readFile,
  writeFile,
  mkdir,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createModels } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";

/** One operator-selected file; no fallback to personal Pi/Codex credential stores. */
export class FileCredentialStore {
  constructor(path) {
    this.path = resolve(path);
  }
  async read(provider) {
    try {
      return JSON.parse(await readFile(this.path, "utf8"))[provider];
    } catch (error) {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }
  }
  async list() {
    const credential = await this.read("openai-codex");
    return credential
      ? [{ providerId: "openai-codex", type: credential.type }]
      : [];
  }
  async modify(provider, fn, { signal } = {}) {
    if (provider !== "openai-codex")
      throw new Error("Unsupported credential provider");
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const lock = `${this.path}.lock`;
    const deadline = Date.now() + 60000;
    while (true) {
      signal?.throwIfAborted();
      try {
        await mkdir(lock, { mode: 0o700 });
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (Date.now() >= deadline)
          throw new Error(
            "OAuth credential store busy; check the trusted lock directory",
          );
        await delay(100, undefined, { signal });
      }
    }
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      const current = await this.read(provider);
      const next = await fn(current);
      if (next !== undefined) {
        await writeFile(temp, JSON.stringify({ [provider]: next }), {
          mode: 0o600,
          flag: "wx",
        });
        await rename(temp, this.path);
      }
      return next ?? current;
    } finally {
      await rm(temp, { force: true });
      await rmdir(lock);
    }
  }
  async delete() {
    throw new Error("Logout is an operator file operation");
  }
}

export function createCodexModels(authFile) {
  const models = createModels({
    credentials: new FileCredentialStore(authFile),
  });
  models.setProvider(openaiCodexProvider());
  return models;
}

export function createTrustedModels({
  provider = "openai-codex",
  authFile,
  apiKeyEnv,
}) {
  if (provider === "openai-codex") {
    if (!authFile) throw new Error("Explicit trusted authFile required");
    return createCodexModels(authFile);
  }
  if (provider !== "deepseek" || !apiKeyEnv)
    throw new Error("Configure supported trusted provider and apiKeyEnv");
  const models = createModels({
    authContext: {
      async env(name) {
        return name === "DEEPSEEK_API_KEY" ? process.env[apiKeyEnv] : undefined;
      },
      async fileExists() {
        return false;
      },
    },
  });
  models.setProvider(deepseekProvider());
  return models;
}
