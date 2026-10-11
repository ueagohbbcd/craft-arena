import { createRequire } from "node:module";
import { findBlocksInColumns } from "./find-blocks.mjs";
const require = createRequire(import.meta.url);
const { Vec3 } = require("vec3");
const vector = (p) => new Vec3(p.x, p.y, p.z);
const key = (x, z) => `${x},${z}`;
const copyBlock = (chunk, p, worldPosition = p) => {
  const block = chunk.getBlock(vector(p));
  block.position = vector(worldPosition);
  if (block.entity != null) block.entity = structuredClone(block.entity);
  return block;
};
const inHeight = (record, y) =>
  y >= record.minY && y < record.minY + record.height;

/** HTTP-only reader: creates no Minecraft login, SSE subscription or controls. */
export class BlockMemoryClient {
  #cache = new Map();
  #identity;
  constructor({
    url = process.env.ARENA_BRIDGE_URL,
    token = process.env.ARENA_BRIDGE_TOKEN,
    fetchImpl = fetch,
  } = {}) {
    if (!url || !token)
      throw new Error("Block memory requires bridge URL and token");
    this.url = url.replace(/\/$/, "");
    this.token = token;
    this.fetch = fetchImpl;
  }
  async #query(kind, values = {}) {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(values))
      if (value !== undefined) query.set(name, String(value));
    const response = await this.fetch(
      `${this.url}/v1/memory/${kind}?${query}`,
      {
        headers: { authorization: `Bearer ${this.token}` },
      },
    );
    const body = await response.json();
    if (!response.ok || !body.ok)
      throw Object.assign(
        new Error(body.error ?? `Memory HTTP ${response.status}`),
        { status: response.status },
      );
    return body.result;
  }
  /** Fresh server-memory record; unknown is explicit and is never air. */
  block({ x, y, z, dimension } = {}) {
    return this.#query("block", { x, y, z, dimension });
  }
  /** Chunk x/z coordinates (not world-block coordinates). Native JSON plus freshness. */
  chunk({ x, z, dimension } = {}) {
    return this.#query("chunk", { x, z, dimension });
  }
  /** One bounded page of remembered columns, including unloaded dimensions. */
  chunks({ dimension, offset, limit } = {}) {
    return this.#query("chunks", { dimension, offset, limit });
  }
  clearCache() {
    this.#cache.clear();
    this.#identity = undefined;
  }
  /** Explicit network boundary. Refresh requested columns, then return a local snapshot. */
  async prefetch({ dimension, columns } = {}) {
    if (typeof dimension !== "string" || !dimension || !Array.isArray(columns))
      throw new Error("prefetch requires dimension and columns [{x,z}]");
    // Sequential requests avoid a large transfer burst and preserve response order.
    for (const { x, z } of columns) {
      const record = await this.chunk({ dimension, x, z });
      const identity = JSON.stringify([
        record.scope,
        record.instanceId,
        record.version,
      ]);
      if (this.#identity !== identity) {
        this.#cache.clear();
        this.#identity = identity;
      }
      const cachedAt = Date.now();
      const Chunk = record.known
        ? require("prismarine-chunk")(record.version)
        : null;
      if (!this.#cache.has(dimension)) this.#cache.set(dimension, new Map());
      this.#cache.get(dimension).set(key(x, z), {
        ...record,
        x,
        z,
        cachedAt,
        chunk: record.known ? Chunk.fromJson(record.data) : null,
      });
    }
    return this.cached(dimension);
  }
  /** Synchronous queries over already-prefetched data, with no implicit I/O. */
  cached(dimension) {
    if (typeof dimension !== "string" || !dimension)
      throw new Error("dimension is required");
    return createCachedView(
      dimension,
      new Map(this.#cache.get(dimension) ?? []),
    );
  }
}
export const createBlockMemoryClient = (options) =>
  new BlockMemoryClient(options);

function createCachedView(dimension, records) {
  const entryAt = (p) =>
    records.get(key(Math.floor(p.x / 16), Math.floor(p.z / 16)));
  const blockAt = (position) => {
    const p = vector(position).floored(),
      record = entryAt(p);
    if (!record?.known || !inHeight(record, p.y)) return null;
    return copyBlock(record.chunk, { x: p.x & 15, y: p.y, z: p.z & 15 }, p);
  };
  const metadata = (record) => {
    const { chunk, data, ...info } = record;
    return structuredClone({
      ...info,
      source: "prefetched_memory",
      cacheAgeMs: Date.now() - record.cachedAt,
    });
  };
  const lookup = (position) => {
    const record = entryAt(position);
    if (!record)
      return { known: false, status: "not_cached", dimension, block: null };
    const info = metadata(record),
      block = blockAt(position);
    if (!block && record.known)
      return {
        ...info,
        known: false,
        status: "unknown",
        reason: "outside_dimension_height",
        block: null,
      };
    return { ...info, block };
  };
  const getColumn = (x, z) => {
    const record = records.get(key(x, z));
    if (!record?.known) return null;
    const valid = (p) =>
      Number.isInteger(p.x) &&
      p.x >= 0 &&
      p.x < 16 &&
      Number.isInteger(p.z) &&
      p.z >= 0 &&
      p.z < 16 &&
      Number.isInteger(p.y) &&
      inHeight(record, p.y);
    const getBlock = (p) => (valid(p) ? copyBlock(record.chunk, p) : null);
    return Object.freeze({
      minY: record.minY,
      worldHeight: record.height,
      getBlock,
      getBlockStateId: (p) => getBlock(p)?.stateId ?? null,
      getBlockType: (p) => getBlock(p)?.type ?? null,
      getBlockLight: (p) => getBlock(p)?.light ?? null,
      getSkyLight: (p) => getBlock(p)?.skyLight ?? null,
      getBiome: (p) => getBlock(p)?.biome?.id ?? null,
      toJson: () => record.chunk.toJson(),
    });
  };
  const searchColumns = new Map();
  for (const [id, record] of records)
    if (record.known) searchColumns.set(id, { chunk: record.chunk });
  const version = [...records.values()].find(
    (record) => record.version,
  )?.version;
  const registry = version ? require("prismarine-registry")(version) : null;
  const findBlocks = ({
    matching,
    point,
    maxDistance = 16,
    count = 1,
  } = {}) => {
    if (
      !point ||
      ![point.x, point.y, point.z, maxDistance, count].every(Number.isFinite) ||
      maxDistance < 0 ||
      !Number.isSafeInteger(count) ||
      count < 0
    )
      throw new Error(
        "findBlocks requires finite point, nonnegative maxDistance and integer count",
      );
    // No player/entity position is available to this independent reader.
    return findBlocksInColumns(
      { columns: searchColumns, registry, _vector: vector },
      {
        matching:
          typeof matching === "function"
            ? (block) => matching(blockAt(block.position))
            : matching,
        point: vector(point),
        maxDistance,
        count,
      },
    );
  };
  return Object.freeze({
    dimension,
    blockAt,
    lookup,
    findBlocks,
    findBlock: (options) => {
      const p = findBlocks({ ...options, count: 1 })[0];
      return p ? blockAt(p) : null;
    },
    columns: () => [...records.values()].map(metadata),
    world: Object.freeze({
      getBlock: blockAt,
      getColumn,
      getColumnAt: (p) => getColumn(Math.floor(p.x / 16), Math.floor(p.z / 16)),
      getColumns: () =>
        [...records]
          .filter(([, r]) => r.known)
          .map(([id]) => {
            const [chunkX, chunkZ] = id.split(",").map(Number);
            return { chunkX, chunkZ, column: getColumn(chunkX, chunkZ) };
          }),
    }),
  });
}
