import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

/** Single-process, synchronous claims make simultaneous tool completions safe. */
export class Inbox extends EventEmitter {
  constructor({
    sessionId = randomUUID(),
    maxItems = 256,
    maxBytes = 262144,
    ttlMs = 300000,
    now = Date.now,
  } = {}) {
    super();
    if (
      !Number.isInteger(maxItems) ||
      maxItems < 1 ||
      !Number.isInteger(maxBytes) ||
      maxBytes < 256 ||
      !(ttlMs > 0)
    )
      throw new Error("Invalid inbox limits");
    Object.assign(this, { sessionId, maxItems, maxBytes, ttlMs, now });
    this.items = [];
    this.bytes = 0;
    this.dropped = { overflow: 0, expired: 0 };
    this.totalDropped = { overflow: 0, expired: 0 };
  }
  prune() {
    const now = this.now();
    for (const item of [...this.items])
      if (item.expiresAt <= now) {
        this.remove(item.id);
        this.drop("expired");
      }
  }
  drop(reason) {
    this.dropped[reason]++;
    this.totalDropped[reason]++;
  }
  post(input, { onDelivered, source = "program" } = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Message must be an object");
    if (input.sessionId !== this.sessionId) throw new Error("Session mismatch");
    const { kind = "event", key, data, priority = "normal" } = input;
    if (
      !["event", "state", "judgment"].includes(kind) ||
      !["normal", "urgent"].includes(priority)
    )
      throw new Error("Invalid kind or priority");
    if (kind === "state" && (typeof key !== "string" || !key))
      throw new Error("State needs a nonempty string key");
    if (data === undefined) throw new Error("Message data is required");
    const ttl = input.ttlMs ?? this.ttlMs;
    if (!Number.isFinite(ttl) || ttl <= 0)
      throw new Error("Invalid message TTL");
    this.prune();
    const message = {
      id: randomUUID(),
      sessionId: this.sessionId,
      source,
      kind,
      ...(key ? { key } : {}),
      data,
      priority,
      createdAt: this.now(),
      expiresAt: this.now() + ttl,
    };
    const encoded = JSON.stringify(message);
    const bytes = Buffer.byteLength(encoded);
    if (bytes > this.maxBytes) {
      this.drop("overflow");
      return { accepted: false, reason: "oversize" };
    }
    if (kind === "state")
      for (const old of [...this.items])
        if (
          old.message.kind === "state" &&
          old.message.key === key &&
          old.message.source === source
        )
          this.remove(old.id);
    while (
      this.items.length >= this.maxItems ||
      this.bytes + bytes > this.maxBytes
    ) {
      this.remove(this.items[0].id);
      this.drop("overflow");
    }
    this.items.push({
      id: message.id,
      message: JSON.parse(encoded),
      bytes,
      expiresAt: message.expiresAt,
      onDelivered,
    });
    this.bytes += bytes;
    if (priority === "urgent") this.emit("urgent", message);
    this.emit("message", message);
    return { accepted: true, id: message.id };
  }
  remove(id) {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return false;
    this.bytes -= this.items[i].bytes;
    this.items.splice(i, 1);
    return true;
  }
  /** Claim and acknowledge only at the final model-visible boundary. */
  drain() {
    this.prune();
    const items = this.items;
    const dropped = this.dropped;
    this.items = [];
    this.bytes = 0;
    this.dropped = { overflow: 0, expired: 0 };
    for (const item of items) item.onDelivered?.();
    return {
      sessionId: this.sessionId,
      messages: items.map((x) => x.message),
      dropped,
      totalDropped: { ...this.totalDropped },
    };
  }
  get pending() {
    this.prune();
    return (
      this.items.length > 0 ||
      this.dropped.overflow > 0 ||
      this.dropped.expired > 0
    );
  }
}
