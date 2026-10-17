import { cp, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { defaultScripts } from "./default-scripts.mjs";

const imageTypes = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const missing = (error) => error?.code === "ENOENT";
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

async function listFiles(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort(byName);
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
}

/**
 * default-scripts.json is a list of script names, or an object of lists keyed
 * by bot name (the bot is ARENA_BOT). Returns the comma list the extension
 * reads from ARENA_DEFAULT_SCRIPTS.
 */
function defaultScriptsFrom(text, env) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`default-scripts.json: ${error.message}`);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (!env.ARENA_BOT)
      throw new Error(
        "default-scripts.json is keyed by bot name, but ARENA_BOT is not set",
      );
    value = Object.hasOwn(value, env.ARENA_BOT) ? value[env.ARENA_BOT] : [];
  }
  if (!Array.isArray(value) || !value.every((n) => typeof n === "string"))
    throw new Error(
      "default-scripts.json must be a list of script names, or an object of such lists keyed by bot name",
    );
  const list = value.join(",");
  defaultScripts({ ARENA_DEFAULT_SCRIPTS: list }); // Unknown names are an error now, not at session start.
  return list;
}

/**
 * Files the map (or operator) places under the participant's config directory
 * (/arena/config in the image). Every file is optional; a missing directory
 * means the defaults.
 *
 *   first-message.md      the opening message, replacing the default text
 *   images/*              images sent with the opening message
 *   agents.d/*.md         appended to the system prompt in file-name order,
 *                         together with the image's own fragments
 *                         (builtinAgentsDir); a config file of the same name
 *                         replaces the built-in one
 *   skills/               an extra Pi skills directory
 *   default-scripts.json  default scripts, see defaultScriptsFrom
 */
export async function readParticipantConfig(
  directory,
  { env = {}, builtinAgentsDir } = {},
) {
  const config = { systemPromptFiles: [], images: [] };
  const fragments = new Map();
  for (const dir of [
    builtinAgentsDir,
    directory && join(directory, "agents.d"),
  ])
    if (dir)
      for (const name of await listFiles(dir))
        if (name.endsWith(".md")) fragments.set(name, join(dir, name));
  config.systemPromptFiles = [...fragments.keys()]
    .sort(byName)
    .map((name) => fragments.get(name));
  if (!directory) return config;
  const firstMessage = await readOptional(join(directory, "first-message.md"));
  if (firstMessage?.trim()) config.firstMessage = firstMessage.trim();
  const imagesDir = join(directory, "images");
  for (const name of await listFiles(imagesDir)) {
    const mimeType = imageTypes[extname(name).toLowerCase()];
    if (!mimeType)
      throw new Error(
        `images/${name}: unsupported image type (use ${Object.keys(imageTypes).join(", ")})`,
      );
    const data = await readFile(join(imagesDir, name));
    config.images.push({
      type: "image",
      data: data.toString("base64"),
      mimeType,
    });
  }
  const skillsDir = join(directory, "skills");
  try {
    if ((await stat(skillsDir)).isDirectory()) config.skillsDir = skillsDir;
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const scripts = await readOptional(join(directory, "default-scripts.json"));
  if (scripts !== undefined)
    config.defaultScripts = defaultScriptsFrom(scripts, env);
  return config;
}

/** Whether a generated model profile declares image input. */
export function profileAcceptsImages(profile) {
  if (!profile?.generated) return true; // The operator's own profile: Pi decides.
  const models = profile.models?.providers?.arena?.models ?? [];
  const model = models.find((m) => m.id === profile.modelId);
  return Boolean(model?.input?.includes("image"));
}

/**
 * Copy the workspace files the trusted side provisioned (manifest.json in
 * ARENA_PROVISION_DIR) into the workspace: a target /workspace/<path> lands at
 * <workspace>/<path>. Mode "once" keeps a file that already exists there.
 * Returns the targets written.
 */
export async function applyProvisionFiles(directory, { workspace }) {
  if (!directory) return [];
  const text = await readOptional(join(directory, "manifest.json"));
  if (text === undefined) return [];
  const manifest = JSON.parse(text);
  const written = [];
  for (const file of manifest.files ?? []) {
    const path = String(file.target);
    if (!path.startsWith("/workspace/") || path.split("/").includes(".."))
      throw new Error(`manifest.json: target ${path} is outside /workspace`);
    const target = join(workspace, path.slice("/workspace/".length));
    if (file.mode === "once") {
      try {
        await stat(target);
        continue;
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    await mkdir(dirname(target), { recursive: true });
    await cp(join(directory, file.source), target, { recursive: true });
    written.push(target);
  }
  return written;
}
