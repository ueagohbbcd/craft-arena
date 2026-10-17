import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Public session fields shown to the model in the opening prompt and in session.json. */
const briefingKeys = [
  "kind",
  "sessionId",
  "participantId",
  "teamId",
  "username",
  "teams",
  "map",
];

export function briefingFields(host) {
  return Object.fromEntries(
    briefingKeys
      .filter((key) => host[key] !== undefined)
      .map((key) => [key, host[key]]),
  );
}

export function briefingOf(host) {
  return host?.briefing && typeof host.briefing === "object"
    ? host.briefing
    : {};
}

/** Briefing text and mode instructions as one Markdown file. */
function briefingMarkdown(briefing) {
  const parts = [];
  if (typeof briefing.text === "string" && briefing.text)
    parts.push(`# Session briefing\n\n${briefing.text}`);
  if (typeof briefing.prompt === "string" && briefing.prompt.trim())
    parts.push(`# Mode instructions\n\n${briefing.prompt.trim()}`);
  return parts.length ? `${parts.join("\n\n")}\n` : "";
}

async function replaceFile(path, text) {
  // Unique per write: the opening prompt and the 2 s poll can overlap.
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, text);
  await rename(temporary, path);
}

/**
 * Session directory: copies of the trusted briefing the model can re-read
 * after context compaction. session.json and briefing.md are written once a
 * session is known; public.json is rewritten whenever the session's public data
 * changes. Files written here are a convenience copy, never read back as
 * trusted input.
 */
export function createSessionFiles({ directory }) {
  let publicText;
  let ready;
  return {
    directory,
    files: {
      session: join(directory, "session.json"),
      briefing: join(directory, "briefing.md"),
      public: join(directory, "public.json"),
    },
    /** Write every file for this host reading; returns the paths written. */
    async write(host) {
      ready ??= mkdir(directory, { recursive: true, mode: 0o755 });
      await ready;
      const written = [this.files.session];
      await replaceFile(
        this.files.session,
        `${JSON.stringify(briefingFields(host), null, 2)}\n`,
      );
      const markdown = briefingMarkdown(briefingOf(host));
      if (markdown) {
        await replaceFile(this.files.briefing, markdown);
        written.push(this.files.briefing);
      }
      await this.updatePublic(host);
      written.push(this.files.public);
      return written;
    },
    /** Rewrite public.json when the public data changed; true when it did. */
    async updatePublic(host) {
      const value = briefingOf(host).public;
      const text = `${JSON.stringify(value && typeof value === "object" ? value : null, null, 2)}\n`;
      if (text === publicText) return false;
      ready ??= mkdir(directory, { recursive: true, mode: 0o755 });
      await ready;
      await replaceFile(this.files.public, text);
      publicText = text;
      return true;
    },
  };
}

/**
 * Top-level regular files (or links to them, as a mounted secret or config
 * map often is) in an operator-provided rules directory, sorted.
 */
export async function listRuleFiles(directory, limit = 50) {
  if (!directory) return [];
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (
        entry.isFile() ||
        (entry.isSymbolicLink() &&
          (await stat(path).then(
            (s) => s.isFile(),
            () => false,
          )))
      )
        files.push(path);
    }
    return files.sort().slice(0, limit);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
