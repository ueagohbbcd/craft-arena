import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { findBlocksInColumns } from "./find-blocks.mjs";
const require = createRequire(import.meta.url);
const controls = [
  "forward",
  "back",
  "left",
  "right",
  "jump",
  "sprint",
  "sneak",
];
const wireStringify = (value) =>
  JSON.stringify(value, (_key, v) =>
    typeof v === "bigint" ? { $arenaBigInt: v.toString() } : v,
  );
const parseWire = (text) =>
  JSON.parse(text, (_key, value) =>
    value &&
    typeof value === "object" &&
    Object.keys(value).length === 1 &&
    typeof value.$arenaBigInt === "string" &&
    /^-?[0-9]{1,80}$/.test(value.$arenaBigInt)
      ? BigInt(value.$arenaBigInt)
      : value,
  );
export class Vector {
  constructor(x = 0, y = 0, z = 0) {
    Object.assign(this, { x, y, z });
  }
  clone() {
    return new this.constructor(this.x, this.y, this.z);
  }
  offset(x, y, z) {
    return new this.constructor(this.x + x, this.y + y, this.z + z);
  }
  plus(v) {
    return this.offset(v.x, v.y, v.z);
  }
  minus(v) {
    return this.offset(-v.x, -v.y, -v.z);
  }
  scaled(n) {
    return new this.constructor(this.x * n, this.y * n, this.z * n);
  }
  floored() {
    return new this.constructor(
      Math.floor(this.x),
      Math.floor(this.y),
      Math.floor(this.z),
    );
  }
  distanceTo(v) {
    return this.minus(v).norm();
  }
  norm() {
    return Math.hypot(this.x, this.y, this.z);
  }
  normalize() {
    return this.scaled(1 / (this.norm() || 1));
  }
  equals(v) {
    return !!v && this.x === v.x && this.y === v.y && this.z === v.z;
  }
}
const coords = (v) => ({ x: v.x, y: v.y, z: v.z });
const key = (v) => `${Math.floor(v.x)},${Math.floor(v.y)},${Math.floor(v.z)}`;
export class BotFacade extends EventEmitter {
  constructor({
    url,
    token,
    fetchImpl = fetch,
    reconnectDelay = 250,
    loadRegistry = true,
  }) {
    super();
    this.url = url.replace(/\/$/, "");
    this.token = token;
    this.fetch = fetchImpl;
    this.reconnectDelay = reconnectDelay;
    this.loadRegistry = loadRegistry;
    this.entities = {};
    this.controlState = {};
    this.blocks = new Map();
    this.columns = new Map();
    this.knownBlocks = new Map();
    this.maxKnownBlocks = 50000;
    this.Vec3 = Vector;
    this.sequence = -1;
    this.epoch = null;
    this.closed = false;
    this._pending = new Set();
    this._controlTail = Promise.resolve();
    this._queuedControls = new Map();
    this._windows = new Map();
    this._closedWindowRefs = new Set();
    this._pendingOpens = 0;
    this._windowStateRevision = -1;
    this._plugins = new Set();
    this.on("error", () => {});
    this.inventory = new EventEmitter();
    this.inventory.slots = [];
    this.inventory.items = () =>
      this.inventory.slots
        .slice(
          this.inventory.inventoryStart ?? 9,
          this.inventory.inventoryEnd ?? 45,
        )
        .filter(Boolean);
    this.inventory.emptySlotCount = () =>
      this.inventory.slots
        .slice(this.inventory.inventoryStart, this.inventory.inventoryEnd)
        .filter((x) => !x).length;
    this.world = { getBlock: (p) => this.blockAt(p) };
  }
  async action(action, args = {}) {
    if (this.closed) throw new Error("Bridge closed");
    const res = await this.fetch(`${this.url}/v1/action`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: wireStringify({ action, args }),
    });
    const text = await res.text();
    const body = text ? parseWire(text) : {};
    if (!res.ok || !body.ok) {
      const details = body.errorDetails ?? {};
      const error = new Error(
        details.message ?? body.error ?? `Bridge action HTTP ${res.status}`,
      );
      error.name = details.name ?? "Error";
      if (details.code !== undefined) error.code = details.code;
      error.action = details.action ?? action;
      error.status = res.status;
      throw error;
    }
    return body.result;
  }
  async getMatchState() {
    const res = await this.fetch(`${this.url}/v1/match`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(`Match state HTTP ${res.status}`);
    const body = await res.json();
    return body.result;
  }
  _fire(action, args) {
    // Native movement controls apply in call order. Concurrent HTTP requests
    // can arrive out of order, so queue just these short writes per facade.
    // Long actions (dig/equip/etc.) must not delay a release or stop.
    const ordered =
      action === "setControlState" ||
      action === "clearControlStates" ||
      action === "stop";
    // Repeated plugin ticks can enqueue identical states faster than the
    // transport drains them. Reuse only an equivalent *unsent* write. Remove
    // it before dispatch, so a later assertion still reaches the authority
    // after errors, native state changes or another client's control writes.
    let queued;
    if (action === "setControlState") {
      const previous = this._queuedControls.get(args.control);
      if (previous?.state === args.state) return previous.promise;
      queued = { state: args.state };
      this._queuedControls.set(args.control, queued);
    } else if (ordered) {
      // Clear/stop are ordering barriers; never merge assertions across them.
      this._queuedControls.clear();
    }
    const p = ordered
      ? this._controlTail.then(() => {
          if (queued && this._queuedControls.get(args.control) === queued)
            this._queuedControls.delete(args.control);
          return this.action(action, args);
        })
      : this.action(action, args);
    if (queued) queued.promise = p;
    if (ordered) this._controlTail = p.catch(() => {});
    // Include queued, not-yet-sent writes so flush observes the entire queue.
    this._pending.add(p);
    p.then(
      () => {
        this._pending.delete(p);
      },
      (error) => {
        this._pending.delete(p);
        this._unreportedActionError ??= error;
        this.emit("error", error);
      },
    );
    return p;
  }
  async flush() {
    await Promise.allSettled([...this._pending]);
    const error = this._unreportedActionError;
    this._unreportedActionError = undefined;
    if (error) throw error;
  }
  async configure(version) {
    if (this.version === version) return;
    this.version = version;
    if (!this.loadRegistry) return;
    const Registry = require("prismarine-registry"),
      Block = require("prismarine-block"),
      Item = require("prismarine-item");
    this.registry = Registry(version);
    this.Block = Block(this.registry);
    this.Item = Item(this.registry);
    this.Window = require("prismarine-windows")(this.registry).Window;
    this.Chunk = require("prismarine-chunk")(this.registry);
    this.Vec3 = require("vec3").Vec3;
    this.physics = require("prismarine-physics").Physics(
      this.registry,
      this.world,
    );
    this.supportFeature = (name) => this.registry.supportFeature(name);
  }
  _vector(v) {
    return v ? new this.Vec3(v.x, v.y, v.z) : new this.Vec3();
  }
  _entity(data) {
    if (!data) return null;
    const e = (this.entities[data.id] ??= {});
    Object.assign(e, data, {
      position: this._vector(data.position),
      velocity: this._vector(data.velocity),
    });
    return e;
  }
  _block(data) {
    if (!data) return null;
    let b;
    if (this.Block && Number.isInteger(data.stateId)) {
      b = this.Block.fromStateId(data.stateId, data.biomeId ?? 0);
      b.position = this._vector(data.position);
      b.light = data.light;
      b.skyLight = data.skyLight;
      if (data.entity !== undefined) b.entity = data.entity;
    } else b = { ...data, position: this._vector(data.position) };
    return b;
  }
  _item(data) {
    if (!data) return null;
    const i = this.Item
      ? new this.Item(data.type, data.count, data.metadata, data.nbt)
      : {};
    Object.assign(i, data);
    if (data.components)
      i.componentMap = new Map(
        data.components.map((component) => [component.type, component]),
      );
    return i;
  }
  async accept(frame) {
    if (frame.type === "reset") {
      this.epoch = frame.epoch;
      this.sequence = frame.sequence;
      this.entities = {};
      this._windows.clear();
      this._closedWindowRefs.clear();
      this._windowStateRevision = -1;
      this.currentWindow = null;
      this.blocks.clear();
      this.columns.clear();
      this.knownBlocks.clear();
      await this._snapshot(frame.data);
      this.emit("bridgeReset");
      return;
    }
    if (frame.epoch !== this.epoch || frame.sequence !== this.sequence + 1)
      throw new Error("Bridge sequence gap");
    this.sequence = frame.sequence;
    if (frame.type === "snapshot") await this._snapshot(frame.data);
    else if (frame.type === "event") {
      const { name, args } = frame.data;
      let local = args;
      if (name.startsWith("entity")) local = args.map((e) => this._entity(e));
      else if (name === "blockUpdate") {
        local = args.map((b) => this._block(b));
        if (local[1]) {
          this.blocks.set(key(local[1].position), local[1]);
          this._rememberBlock(local[1], Date.now());
          this._updateColumn(local[1]);
        }
      } else if (name === "blockEntityData") {
        local = args.map((b) => this._block(b));
        if (local[0]) {
          this.blocks.set(key(local[0].position), local[0]);
          this._rememberBlock(local[0], Date.now());
          this._updateColumn(local[0]);
        }
      } else if (name === "chunkColumnLoad" || name === "chunkColumnUnload") {
        local = args.map((v) => this._vector(v));
        const x = Math.floor(args[0].x / 16),
          z = Math.floor(args[0].z / 16);
        if (name === "chunkColumnLoad") await this._loadColumn(x, z);
        else this.columns.delete(`${x},${z}`);
      }
      if (name === "diggingCompleted" || name === "diggingAborted")
        local = args.map((block) => this._block(block));
      if (name === "windowOpen") {
        const window = args[0] ? this._window(args[0]) : this.currentWindow;
        if (window) this._setCurrentWindow(window, args[0]?.windowRevision);
        local = [window];
      } else if (name === "windowClose") {
        const window = args[0] ? this._window(args[0]) : this._lastWindow;
        if (window) {
          if (this._pendingOpens) this._closedWindowRefs.add(window.windowRef);
          if (this.currentWindow === window)
            this._setCurrentWindow(null, args[0]?.windowRevision);
          window.emit("close");
          if (!this._pendingOpens)
            this._windows.delete(window.windowRef ?? window.id);
        }
        local = [window];
      }
      this.emit(name, ...local);
      if (name === "entityGone" && args[0]) delete this.entities[args[0].id];
    }
  }
  async _snapshot(s) {
    await this.configure(s.version);
    if (this.game?.dimension !== s.game?.dimension) {
      this.columns.clear();
      this.blocks.clear();
      this.knownBlocks.clear();
    }
    for (const k of [
      "sampledAt",
      "username",
      "connectionStatus",
      "disconnectReason",
      "game",
      "health",
      "food",
      "oxygenLevel",
      "jumpTicks",
      "jumpQueued",
    ])
      this[k] = s[k];
    const ids = new Set();
    for (const e of s.entities) {
      this._entity(e);
      ids.add(e.id);
    }
    this.entity = this._entity(s.entity);
    if (s.entity) ids.add(s.entity.id);
    for (const id of Object.keys(this.entities))
      if (!ids.has(Number(id))) delete this.entities[id];
    this.controlState = { ...s.controlState };
    this._applyInventoryState(s);
    this.hasColumnMirror = !!(s.columns && this.Chunk);
    if (this.hasColumnMirror) {
      const wanted = new Set(s.columns.map(({ x, z }) => `${x},${z}`));
      for (const id of this.columns.keys())
        if (!wanted.has(id)) this.columns.delete(id);
      // Fetch columns once, in parallel batches. Search never performs a remote read.
      for (let i = 0; i < s.columns.length; i += 4)
        await Promise.all(
          s.columns
            .slice(i, i + 4)
            .map(({ x, z }) =>
              this.columns.has(`${x},${z}`) ? null : this._loadColumn(x, z),
            ),
        );
    }
    if (s.replaceBlocks !== false) this.blocks.clear();
    for (const data of s.blocks) {
      const b = this._block(data);
      this.blocks.set(key(b.position), b);
      this._rememberBlock(b, s.sampledAt ?? Date.now());
      this._updateColumn(b, s.sampledAt);
    }
  }
  _applyInventoryState(s) {
    // HTTP inventory results and SSE snapshots share authority revisions.
    // An older snapshot must not roll back held-item or quickbar state either.
    if (
      s.inventory?.windowRef !== this.inventory.windowRef ||
      !(s.inventory?.windowRevision < this.inventory.windowRevision)
    ) {
      this.quickBarSlot = s.quickBarSlot;
      this.heldItem = this._item(s.heldItem);
      this._window(s.inventory, this.inventory);
    }
    this._setCurrentWindow(
      s.currentWindow ? this._window(s.currentWindow) : null,
      Math.max(
        s.inventory?.windowRevision ?? -1,
        s.currentWindow?.windowRevision ?? -1,
      ),
    );
  }
  _setCurrentWindow(window, revision = -1) {
    if (revision >= 0 && revision < this._windowStateRevision) return;
    if (window && this._closedWindowRefs.has(window.windowRef)) return;
    if (this.currentWindow && this.currentWindow !== window) {
      this._lastWindow = this.currentWindow;
      if (this._pendingOpens)
        this._closedWindowRefs.add(this.currentWindow.windowRef);
    }
    this.currentWindow = window;
    this._windowStateRevision = Math.max(this._windowStateRevision, revision);
  }
  _window(data, target) {
    if (!data) return null;
    this.Window ??= require("prismarine-windows")(this.version).Window;
    const key = data.windowRef ?? data.id;
    let window = target ?? this._windows.get(key);
    if (!window && data.windowRef === this.inventory.windowRef)
      window = this.inventory;
    if (
      window &&
      data.windowRef === window.windowRef &&
      data.windowRevision < window.windowRevision
    )
      return window;
    if (!window) {
      window = new this.Window(
        data.id,
        data.type,
        data.title,
        data.slots.length,
        { start: data.inventoryStart, end: data.inventoryEnd - 1 },
        data.craftingResultSlot,
        data.requiresConfirmation,
      );
      this._windows.set(key, window);
      window.close = () => this.closeWindow(window);
      for (const method of ["withdraw", "deposit"])
        window[method] = async (itemType, metadata, count, nbt) => {
          const result = await this.action(
            method === "withdraw" ? "windowWithdraw" : "windowDeposit",
            {
              windowRef: window.windowRef,
              itemType,
              metadata,
              count,
              nbt,
            },
          );
          this._window(result);
        };
    } else if (!(window instanceof this.Window)) {
      // Keep inventory listeners/reference while using upstream query methods.
      Object.setPrototypeOf(window, this.Window.prototype);
      delete window.items;
      delete window.emptySlotCount;
    }
    this._windows.set(key, window);
    const oldSlots = window.slots ?? [];
    const { slots, selectedItem, ...fields } = data;
    Object.assign(window, fields);
    window.slots = slots.map((item, slot) => {
      const value = this._item(item);
      if (value) value.slot = slot;
      return value;
    });
    window.selectedItem = this._item(selectedItem);
    for (let slot = 0; slot < window.slots.length; slot++) {
      const before = oldSlots[slot] ?? null,
        after = window.slots[slot];
      if (!isDeepStrictEqual(before, after)) {
        window.emit("updateSlot", slot, before, after);
        window.emit(`updateSlot:${slot}`, before, after);
      }
    }
    return window;
  }
  async _loadColumn(x, z) {
    if (!this.Chunk) return;
    const response = await this.fetch(`${this.url}/v1/chunk?x=${x}&z=${z}`, {
      headers: { authorization: `Bearer ${this.token}` },
      signal: this.abort?.signal,
    });
    if (!response.ok) throw new Error(`Bridge chunk HTTP ${response.status}`);
    const { result } = await response.json();
    if (result && result.dimension !== this.game?.dimension) return;
    if (result)
      this.columns.set(`${x},${z}`, {
        chunk: this.Chunk.fromJson(result.data),
        sampledAt: result.sampledAt,
      });
    else this.columns.delete(`${x},${z}`);
  }
  _updateColumn(block, sampledAt = Infinity) {
    const p = block.position;
    const column = this.columns.get(
      `${Math.floor(p.x / 16)},${Math.floor(p.z / 16)}`,
    );
    if (!column || sampledAt < column.sampledAt) return;
    // Native blockAt can report air outside a loaded dimension during a fall.
    // Keep the same bounds as blockAt(): those coordinates are not writable
    // chunk sections, and upstream light setters do not guard their arrays.
    const minY = column.chunk.minY ?? this.game?.minY ?? 0;
    const height = column.chunk.worldHeight ?? this.game?.height ?? 256;
    if (p.y < minY || p.y >= minY + height) return;
    const local = this._vector({ x: p.x & 15, y: p.y, z: p.z & 15 });
    column.chunk.setBlockStateId(local, block.stateId);
    if (block.entity !== undefined) {
      if (block.entity === null) column.chunk.removeBlockEntity?.(local);
      else column.chunk.setBlockEntity?.(local, block.entity);
    }
    if (block.light !== undefined)
      column.chunk.setBlockLight(local, block.light);
    if (block.skyLight !== undefined)
      column.chunk.setSkyLight(local, block.skyLight);
  }
  _rememberBlock(block, observedAt) {
    const k = key(block.position);
    this.knownBlocks.delete(k);
    this.knownBlocks.set(k, { block, observedAt, epoch: this.epoch });
    while (this.knownBlocks.size > this.maxKnownBlocks)
      this.knownBlocks.delete(this.knownBlocks.keys().next().value);
  }
  knownBlockAt(position) {
    let entry = this.knownBlocks.get(key(position));
    const column = this.columns.get(
      `${Math.floor(position.x / 16)},${Math.floor(position.z / 16)}`,
    );
    const current = column && this.blockAt(position);
    if (current)
      entry = {
        block: current,
        observedAt: Math.max(column.sampledAt, entry?.observedAt ?? 0),
        epoch: this.epoch,
      };
    return entry
      ? {
          ...entry,
          stale: this.blockAt(position) === null,
          ageMs: Date.now() - entry.observedAt,
        }
      : null;
  }
  *knownBlocksIn(bounds) {
    for (const block of this._blocksInBounds(bounds))
      yield this.knownBlockAt(block.position);
    for (const entry of this.knownBlocks.values()) {
      const p = entry.block.position;
      if (!this.columns.has(`${Math.floor(p.x / 16)},${Math.floor(p.z / 16)}`))
        yield entry;
    }
  }
  blockAt(position) {
    const p = this._vector(position).floored();
    const column = this.columns.get(
      `${Math.floor(p.x / 16)},${Math.floor(p.z / 16)}`,
    );
    if (column) {
      const chunk = column.chunk;
      const minY = chunk.minY ?? this.game?.minY ?? 0;
      const height = chunk.worldHeight ?? this.game?.height ?? 256;
      if (p.y < minY || p.y >= minY + height) return null;
      const block = chunk.getBlock(
        this._vector({ x: p.x & 15, y: p.y, z: p.z & 15 }),
      );
      block.position = p;
      return block;
    }
    return this.hasColumnMirror ? null : (this.blocks.get(key(p)) ?? null);
  }
  nearestEntity(predicate = () => true) {
    return (
      Object.values(this.entities)
        .filter((e) => e !== this.entity && e.position && predicate(e))
        .sort(
          (a, b) =>
            a.position.distanceTo(this.entity.position) -
            b.position.distanceTo(this.entity.position),
        )[0] ?? null
    );
  }
  findBlocks({
    matching,
    maxDistance = 16,
    count = 1,
    point = this.entity.position,
  }) {
    if (this.hasColumnMirror && this.columns.size) {
      return findBlocksInColumns(this, { matching, maxDistance, count, point });
    }
    const match =
      typeof matching === "function"
        ? matching
        : (b) =>
            Array.isArray(matching)
              ? matching.includes(b.type)
              : b.type === matching;
    const candidates = this.hasColumnMirror
      ? this._blocksInBounds({
          min: this._vector(point).offset(
            -maxDistance,
            -maxDistance,
            -maxDistance,
          ),
          max: this._vector(point).offset(
            maxDistance,
            maxDistance,
            maxDistance,
          ),
        })
      : this.blocks.values();
    // Keep only the requested nearest positions while scanning loaded chunks.
    // Negative counts retain Array.slice's existing semantics.
    const limit = count < 0 ? Infinity : Math.trunc(Number(count)) || 0;
    if (limit === 0) return [];
    const nearest = [];
    for (const block of candidates) {
      if (!block) continue;
      const distance = block.position.distanceTo(point);
      if (distance > maxDistance || !match(block)) continue;
      if (
        nearest.length >= limit &&
        distance >= nearest[nearest.length - 1].distance
      )
        continue;
      // Insert after equal distances to preserve iterator order for ties.
      let low = 0,
        high = nearest.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (nearest[middle].distance <= distance) low = middle + 1;
        else high = middle;
      }
      nearest.splice(low, 0, { position: block.position, distance });
      if (nearest.length > limit) nearest.pop();
    }
    return nearest.slice(0, count).map(({ position }) => position);
  }
  *_blocksInBounds({ min, max }) {
    for (const [id, { chunk }] of this.columns) {
      const [cx, cz] = id.split(",").map(Number);
      const minY = chunk.minY ?? this.game?.minY ?? 0;
      const height = chunk.worldHeight ?? this.game?.height ?? 256;
      for (
        let x = Math.max(cx * 16, Math.ceil(min.x));
        x <= Math.min(cx * 16 + 15, Math.floor(max.x));
        x++
      )
        for (
          let z = Math.max(cz * 16, Math.ceil(min.z));
          z <= Math.min(cz * 16 + 15, Math.floor(max.z));
          z++
        )
          for (
            let y = Math.max(minY, Math.ceil(min.y));
            y <= Math.min(minY + height - 1, Math.floor(max.y));
            y++
          )
            yield this.blockAt({ x, y, z });
    }
  }
  findBlock(options) {
    const p = this.findBlocks({ ...options, count: 1 })[0];
    return p ? this.blockAt(p) : null;
  }
  loadPlugin(plugin) {
    if (!this._plugins.has(plugin)) {
      plugin(this, {});
      this._plugins.add(plugin);
    }
  }
  loadPlugins(plugins) {
    for (const p of plugins) this.loadPlugin(p);
  }
  setControlState(control, state) {
    if (!controls.includes(control))
      throw new Error(`invalid control: ${control}`);
    if (typeof state !== "boolean") throw new Error(`invalid state: ${state}`);
    this.controlState[control] = state;
    this._fire("setControlState", { control, state });
  }
  getControlState(control) {
    return this.controlState[control] ?? false;
  }
  clearControlStates() {
    for (const key of controls) this.controlState[key] = false;
    this._fire("clearControlStates", {});
  }
  stop() {
    this._fire("stop", {});
  }
  stopAndCenter() {
    this.stop();
  }
  look(yaw, pitch, force = false) {
    return this.action("look", { yaw, pitch, force });
  }
  lookAt(position, force = false) {
    return this.action("lookAt", { position: coords(position), force });
  }
  attack(entity, swing = true) {
    this._fire("attack", { entityId: entity.id, swing });
  }
  dig(block, forceLook, digFace) {
    return this.action("dig", {
      position: coords(block.position),
      forceLook,
      digFace:
        digFace && typeof digFace === "object" ? coords(digFace) : digFace,
    });
  }
  stopDigging() {
    this._fire("stopDigging", {});
  }
  placeBlock(block, face) {
    return this.action("placeBlock", {
      position: coords(block.position),
      face: coords(face),
    });
  }
  activateBlock(block, direction, cursorPos) {
    return this.action("activateBlock", {
      position: coords(block.position),
      direction: direction && coords(direction),
      cursorPos: cursorPos && coords(cursorPos),
    });
  }
  getEquipmentDestSlot(destination) {
    return {
      hand: 36 + this.quickBarSlot,
      head: 5,
      torso: 6,
      legs: 7,
      feet: 8,
      "off-hand": 45,
    }[destination];
  }
  equip(item, destination = "hand") {
    return this.action("equip", {
      ...(typeof item === "number" ? { itemType: item } : { slot: item.slot }),
      destination: destination || "hand",
    });
  }
  unequip(destination) {
    return this.action("unequip", { destination });
  }
  /** Native completion/error semantics, with authoritative carried slots. */
  async consume() {
    const epoch = this.epoch,
      inventoryRef = this.inventory.windowRef;
    const result = await this.action("consume");
    if (
      result?.inventory &&
      this.epoch === epoch &&
      this.inventory.windowRef === inventoryRef &&
      result.version === this.version &&
      result.inventory.windowRef === inventoryRef
    )
      this._applyInventoryState(result);
  }
  activateItem(offHand = false) {
    this._fire("activateItem", { offHand });
  }
  deactivateItem() {
    this._fire("deactivateItem", {});
  }
  swingArm(arm = "right") {
    this._fire("swingArm", { arm });
  }
  chat(message) {
    this._fire("chat", { message });
  }
  setQuickBarSlot(slot) {
    this._fire("setQuickBarSlot", { slot });
  }
  /** Craft at least count new items, rounded up to complete recipe batches. */
  async craftItem(itemType, count = 1, table = null) {
    const epoch = this.epoch,
      inventoryRef = this.inventory.windowRef;
    const result = await this.action("craft", {
      itemType,
      count,
      table: table ? coords(table.position) : null,
    });
    if (
      result?.inventory &&
      this.epoch === epoch &&
      this.inventory.windowRef === inventoryRef &&
      result.version === this.version &&
      result.inventory.windowRef === inventoryRef
    )
      this._applyInventoryState(result);
  }
  tossStack(item) {
    return this.action("tossStack", {
      slot: item.slot,
      windowRef: (this.currentWindow ?? this.inventory).windowRef,
    });
  }
  async openContainer(target, direction, cursorPos) {
    this._pendingOpens++;
    try {
      const result = await this.action("openContainer", {
        ...(target.id !== undefined
          ? { entityId: target.id }
          : { position: coords(target.position) }),
        direction: direction && coords(direction),
        cursorPos: cursorPos && coords(cursorPos),
      });
      const window = this._window(result);
      if (window) this._setCurrentWindow(window, result.windowRevision);
      return window;
    } finally {
      if (--this._pendingOpens === 0) {
        for (const ref of this._closedWindowRefs) this._windows.delete(ref);
        this._closedWindowRefs.clear();
      }
    }
  }
  async closeWindow(window = this.currentWindow) {
    const epoch = this.epoch,
      inventoryRef = this.inventory.windowRef;
    const result = await this.action(
      "closeWindow",
      window ? { windowRef: window.windowRef } : {},
    );
    // Reconnect/reset can replace the authority while an old HTTP request is
    // still in flight. Never apply that response to the replacement mirror.
    if (this.epoch !== epoch || this.inventory.windowRef !== inventoryRef)
      return;
    if (result?.inventory) {
      if (
        result.version !== this.version ||
        result.inventory.windowRef !== inventoryRef
      )
        return;
      this._applyInventoryState(result);
      return;
    }
    // Keep compatibility with older bridges that return no close snapshot.
    if (this.currentWindow === window) {
      this._lastWindow = window;
      this.currentWindow = null;
      if (window && this._pendingOpens)
        this._closedWindowRefs.add(window.windowRef);
    }
  }
  clickWindow(slot, mouseButton, mode) {
    return this.action("clickWindow", { slot, mouseButton, mode });
  }
  canDigBlock(block) {
    return (
      !!block?.diggable &&
      block.position
        .offset(0.5, 0.5, 0.5)
        .distanceTo(this.entity.position.offset(0, 1.65, 0)) <= 5.1
    );
  }
  waitForTicks(ticks) {
    return new Promise((resolve) => {
      let n = 0;
      const fn = () => {
        if (++n >= ticks) {
          this.off("physicsTick", fn);
          resolve();
        }
      };
      this.on("physicsTick", fn);
    });
  }
  closeBridge() {
    this.closed = true;
    this.abort?.abort();
    this.emit("end", "bridge closed");
  }
}
export async function connectBot(options) {
  const bot = new BotFacade(options);
  let resolve, reject;
  const ready = new Promise((r, j) => {
    resolve = r;
    reject = j;
  });
  let initial = true;
  bot.transport = (async () => {
    while (!bot.closed) {
      bot.abort = new AbortController();
      try {
        const response = await bot.fetch(`${bot.url}/v1/events`, {
          headers: { authorization: `Bearer ${bot.token}` },
          signal: bot.abort.signal,
        });
        if (!response.ok)
          throw new Error(`Bridge events HTTP ${response.status}`);
        const reader = response.body.getReader(),
          decoder = new TextDecoder();
        let buffer = "";
        while (!bot.closed) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (frame.startsWith("data: ")) {
              await bot.accept(parseWire(frame.slice(6)));
              if (initial) {
                initial = false;
                resolve(bot);
              }
            }
          }
        }
      } catch (e) {
        if (initial) {
          bot.closed = true;
          reject(e);
          return;
        }
        if (!bot.closed) bot.emit("error", e);
      } finally {
        bot.abort?.abort();
      }
      if (!bot.closed) {
        bot.emit("bridgeDisconnected");
        await new Promise((r) => setTimeout(r, bot.reconnectDelay));
      }
    }
  })();
  return ready;
}
