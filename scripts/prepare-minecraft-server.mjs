#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultManifest = fileURLToPath(
  new URL("../infra/minecraft-download.json", import.meta.url),
);
const dockerfile = fileURLToPath(
  new URL("../infra/Dockerfile.minecraft", import.meta.url),
);
const version = (value) =>
  typeof value === "string" && /^[A-Za-z0-9.+_-]+$/.test(value);

export function validateServerDownload(manifest) {
  if (!version(manifest.minecraftVersion))
    throw new Error("ServerDownload requires minecraftVersion");
  function artifact(item) {
    if (
      !/^https:\/\//.test(item?.url ?? "") ||
      !Number.isSafeInteger(item.size) ||
      item.size <= 0
    )
      throw new Error("Download requires HTTPS URL and positive size");
    if (
      ![
        ["sha1", 40],
        ["sha256", 64],
        ["sha512", 128],
      ].some(
        ([key, length]) =>
          typeof item[key] === "string" &&
          new RegExp(`^[a-f0-9]{${length}}$`, "i").test(item[key]),
      )
    )
      throw new Error("Download requires a pinned digest");
  }
  artifact(manifest);
  if (manifest.fabric) {
    if (!version(manifest.fabric.loaderVersion))
      throw new Error("Invalid Fabric loaderVersion");
    artifact(manifest.fabric.installer);
    if (
      !Array.isArray(manifest.fabric.libraries) ||
      !manifest.fabric.libraries.length
    )
      throw new Error("Pinned Fabric libraries are required");
    for (const library of manifest.fabric.libraries)
      if (
        !/^libraries\/[A-Za-z0-9_+./-]+\.jar$/.test(library.path ?? "") ||
        library.path.split("/").includes("..") ||
        !/^[a-f0-9]{64}$/i.test(library.sha256 ?? "")
      )
        throw new Error("Invalid pinned Fabric library");
  }
  for (const mod of manifest.mods ?? []) {
    artifact(mod);
    if (!/^[A-Za-z0-9_+.-]+\.jar$/.test(mod.filename ?? ""))
      throw new Error("Invalid mod filename");
  }
  if (manifest.mods?.length && !manifest.fabric)
    throw new Error("Mods require Fabric");
}

export function verifyDownload(bytes, artifact) {
  if (bytes.length !== artifact.size) throw new Error("Download size mismatch");
  for (const algorithm of ["sha1", "sha256", "sha512"])
    if (
      artifact[algorithm] &&
      createHash(algorithm).update(bytes).digest("hex") !==
        artifact[algorithm].toLowerCase()
    )
      throw new Error(`Download ${algorithm} mismatch`);
}

/** Assemble a checked Docker build context, never start or modify a running server. */
export async function prepareMinecraftServer({
  destination,
  manifestPath = defaultManifest,
  serverJar,
  artifactDir,
  fetchImpl = fetch,
}) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  validateServerDownload(manifest);
  destination = resolve(destination);
  const stage = join(
    dirname(destination),
    `.minecraft-prepare-${randomUUID()}`,
  );
  await mkdir(stage, { recursive: true });
  try {
    const download = async (artifact, filename, source) => {
      let bytes;
      if (source || artifactDir)
        bytes = await readFile(source ?? join(artifactDir, basename(filename)));
      else {
        const response = await fetchImpl(artifact.url);
        if (!response.ok)
          throw new Error(
            `Download failed: HTTP ${response.status} (${basename(filename)})`,
          );
        bytes = Buffer.from(await response.arrayBuffer());
      }
      verifyDownload(bytes, artifact);
      await mkdir(dirname(join(stage, filename)), { recursive: true });
      await writeFile(join(stage, filename), bytes);
    };
    await download(manifest, "server.jar", serverJar);
    await mkdir(join(stage, "mods"));
    for (const mod of manifest.mods ?? [])
      await download(mod, `mods/${mod.filename}`);
    let install = '#!/bin/sh\nset -eu\ncd "$(dirname "$0")"\n';
    let launch = "#!/bin/sh\nset -eu\nexec java -Xms512M -Xmx2G ";
    if (manifest.fabric) {
      await download(
        manifest.fabric.installer,
        "fabric-installer.jar",
        artifactDir
          ? join(artifactDir, manifest.fabric.installer.filename)
          : undefined,
      );
      // The reviewed official installer runs only while building, before isolation.
      install += `java -jar fabric-installer.jar server -mcversion '${manifest.minecraftVersion}' -loader '${manifest.fabric.loaderVersion}' -dir .\n`;
      install += "sha256sum -c fabric-libraries.sha256\n";
      install +=
        "find libraries -type f -name '*.jar' | sort > actual-libraries.txt\n";
      install +=
        "cut -c67- fabric-libraries.sha256 | sort > expected-libraries.txt\ncmp actual-libraries.txt expected-libraries.txt\n";
      await writeFile(
        join(stage, "fabric-libraries.sha256"),
        manifest.fabric.libraries
          .map((entry) => `${entry.sha256}  ${entry.path}`)
          .join("\n") + "\n",
      );
      launch +=
        "-Dfabric.gameJarPath=/opt/minecraft/server.jar -Dfabric.modsFolder=/opt/minecraft/mods -jar /opt/minecraft/fabric-server-launch.jar nogui\n";
    } else launch += "-jar /opt/minecraft/server.jar nogui\n";
    await writeFile(join(stage, "install.sh"), install);
    await writeFile(join(stage, "run.sh"), launch);
    await writeFile(
      join(stage, "download.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    await copyFile(dockerfile, join(stage, "Dockerfile"));
    // mkdir is an exclusive claim, including when destination is an empty directory.
    await mkdir(destination);
    try {
      for (const entry of [
        "server.jar",
        "mods",
        "install.sh",
        "run.sh",
        "download.json",
        "Dockerfile",
        ...(manifest.fabric
          ? ["fabric-installer.jar", "fabric-libraries.sha256"]
          : []),
      ])
        await rename(join(stage, entry), join(destination, entry));
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      throw error;
    }
    return manifest;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [destination, ...args] = process.argv.slice(2);
  try {
    if (!destination || args.length % 2)
      throw new Error(
        "Usage: node scripts/prepare-minecraft-server.mjs DEST [--manifest JSON] [--server-jar JAR] [--artifact-dir DIR]",
      );
    const options = { destination };
    for (let index = 0; index < args.length; index += 2) {
      const key = {
        "--manifest": "manifestPath",
        "--server-jar": "serverJar",
        "--artifact-dir": "artifactDir",
      }[args[index]];
      if (!key) throw new Error(`Unknown option ${args[index]}`);
      options[key] = args[index + 1];
    }
    const manifest = await prepareMinecraftServer(options);
    console.log(
      `Prepared checked Minecraft ${manifest.minecraftVersion} build context at ${resolve(destination)}. Build the image before starting a match.`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
