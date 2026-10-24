#!/usr/bin/env node
import { lstat, mkdir, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function directory(path) {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(`Expected an ordinary directory: ${path}`);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Reset only known match state: the Pi transcripts, match artifacts, the `mf`
 * state directory (its game log, `supervisor.log` and program logs) and
 * the Pi extension's command logs. Code, Git, and participant settings stay in
 * place.
 */
export async function archiveParticipantState(cwd, archiveId) {
  if (!/^[A-Za-z0-9_-]+$/.test(archiveId ?? ""))
    throw new Error("A simple archive ID is required");
  const root = resolve(cwd);
  await directory(root);
  const history = join(root, ".arena-history");
  const pi = join(root, ".pi");
  const arena = join(root, ".arena");
  await directory(history);
  await directory(pi);
  await directory(arena);
  const sources = [
    [join(pi, "sessions"), "sessions"],
    [join(root, "match-artifacts"), "match-artifacts"],
    [join(root, ".mf"), "mf"],
    [join(arena, "tasks"), "tasks"],
  ];
  // Validate all paths before moving anything; never follow participant-created links.
  const existing = [];
  for (const [path, name] of sources)
    if (await directory(path)) existing.push([path, name]);
  if (!existing.length) return;
  await mkdir(history, { recursive: true });
  const archive = join(history, archiveId);
  await mkdir(archive); // Never merge with or overwrite a previous archive.
  for (const [path, name] of existing) await rename(path, join(archive, name));
  return archive;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await archiveParticipantState(process.cwd(), process.argv[2]);
