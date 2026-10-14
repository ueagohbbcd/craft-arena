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
    // Latest program facts are independent of delivery history. Reads never drain them.
    this.current = new Map();
    this.currentBytes = 0;
    // How recently queued messages left the queue, for out-of-process receipts.
    this.outcomes = new Map();
    this.maxOutcomes = 4096;
  }
  /** delivered | replaced | expired | overflow | removed, or pending/unknown. */
  outcome(id) {
    if (this.items.some((item) => item.id === id)) return "pending";
    return this.outcomes.get(id) ?? "unknown";
  }
  /** Resolve with the outcome once the message leaves the queue, or after timeoutMs. */
  waitForOutcome(id, timeoutMs = Infinity) {
    return new Promise((resolve) => {
      if (this.outcome(id) !== "pending") return resolve(this.outcome(id));
      const done = () => {
        clearTimeout(timer);
        this.off("settled", onSettled);
        resolve(this.outcome(id));
      };
      const onSettled = (event) => event.id === id && done();
      const timer =
        timeoutMs === Infinity ? undefined : setTimeout(done, timeoutMs);
      this.on("settled", onSettled);
    });
  }
  settle(id, outcome) {
    this.outcomes.set(id, outcome);
    if (this.outcomes.size > this.maxOutcomes)
      this.outcomes.delete(this.outcomes.keys().next().value);
    this.emit("settled", { id, outcome });
  }
  prune() {
    const now = this.now();
    for (const item of [...this.items])
      if (item.expiresAt <= now) {
        this.remove(item.id, "expired");
        this.drop("expired");
      }
  }
  drop(reason) {
    this.dropped[reason]++;
    this.totalDropped[reason]++;
  }
  /**
   * `onDelivered` runs when the model receives the message; `onLost` when it
   * leaves the queue undelivered (expired, overflow, removed), but not when a
   * newer message with the same key replaces it. Neither may post synchronously.
   */
  post(input, { onDelivered, onLost, source = "program" } = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Message must be an object");
    if (input.sessionId !== this.sessionId) throw new Error("Session mismatch");
    const { kind = "event", key, data, priority = "normal" } = input;
    if (
      !["event", "state", "judgment", "current"].includes(kind) ||
      !["normal", "urgent"].includes(priority)
    )
      throw new Error("Invalid kind or priority");
    if (
      ["state", "current"].includes(kind) &&
      (typeof key !== "string" || !key)
    )
      throw new Error("State needs a nonempty string key");
    if (kind === "current" && priority !== "normal")
      throw new Error(
        "Current facts use normal priority; requestJudgment delivers an urgent event",
      );
    if (data === undefined) throw new Error("Message data is required");
    const delay = input.minDeliveryDelayMs ?? 0;
    if (
      !Number.isSafeInteger(delay) ||
      delay < 0 ||
      (delay > 0 && (kind !== "state" || priority !== "normal"))
    )
      throw new Error(
        "minDeliveryDelayMs requires a nonnegative integer and delayed normal state",
      );
    const ttl = input.ttlMs ?? this.ttlMs;
    if (!Number.isFinite(ttl) || ttl <= 0)
      throw new Error("Invalid message TTL");
    this.prune();
    const createdAt = this.now();
    const previous =
      kind === "state"
        ? this.items.find(
            (item) =>
              item.message.kind === "state" &&
              item.message.source === source &&
              item.message.key === key,
          )
        : undefined;
    // Updating a pending state never moves its first eligibility time later.
    const eligibleAt =
      priority === "urgent"
        ? createdAt
        : (previous?.eligibleAt ?? createdAt + delay);
    const message = {
      id: randomUUID(),
      sessionId: this.sessionId,
      source,
      kind,
      ...(key ? { key } : {}),
      data,
      priority,
      createdAt,
      expiresAt: createdAt + ttl,
      ...(kind === "state" &&
      (delay > 0 || (previous?.eligibleAt ?? 0) > createdAt)
        ? { eligibleAt }
        : {}),
      ...(typeof input.taskId === "string" && input.taskId
        ? { taskId: input.taskId }
        : {}),
    };
    const encoded = JSON.stringify(message);
    const bytes = Buffer.byteLength(encoded);
    if (kind === "current") {
      this.pruneCurrent();
      const identity = JSON.stringify([source, key]);
      if (data === null) {
        this.removeCurrent(identity);
        return { accepted: true, id: message.id, cleared: true };
      }
      if (bytes > this.maxBytes) return { accepted: false, reason: "oversize" };
      this.removeCurrent(identity);
      while (
        this.current.size >= this.maxItems ||
        this.currentBytes + bytes > this.maxBytes
      )
        this.removeCurrent(this.current.keys().next().value);
      this.current.set(identity, { message: JSON.parse(encoded), bytes });
      this.currentBytes += bytes;
      return { accepted: true, id: message.id };
    }
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
          this.remove(old.id, "replaced");
    while (
      this.items.length >= this.maxItems ||
      this.bytes + bytes > this.maxBytes
    ) {
      this.remove(this.items[0].id, "overflow");
      this.drop("overflow");
    }
    this.items.push({
      id: message.id,
      message: JSON.parse(encoded),
      bytes,
      expiresAt: message.expiresAt,
      eligibleAt,
      onDelivered,
      onLost,
    });
    this.bytes += bytes;
    if (priority === "urgent") this.emit("urgent", message);
    this.emit("message", message);
    return { accepted: true, id: message.id };
  }
  /** Publish a replaceable fact for request-local status, separate from inbox events. */
  setCurrent(key, data, { source = "program", ttlMs, taskId } = {}) {
    return this.post(
      { sessionId: this.sessionId, kind: "current", key, data, ttlMs, taskId },
      { source },
    );
  }
  removeCurrent(identity) {
    const value = this.current.get(identity);
    if (value) this.currentBytes -= value.bytes;
    return this.current.delete(identity);
  }
  pruneCurrent() {
    for (const [identity, value] of this.current)
      if (value.message.expiresAt <= this.now()) this.removeCurrent(identity);
  }
  currentSnapshot() {
    this.pruneCurrent();
    return structuredClone(
      [...this.current.values()].map(({ message }) => message),
    );
  }
  remove(id, outcome = "removed") {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return false;
    const [item] = this.items.splice(i, 1);
    this.bytes -= item.bytes;
    this.settle(id, outcome);
    if (outcome !== "replaced")
      try {
        item.onLost?.();
      } catch (error) {
        this.emit("deliveryError", {
          id,
          message: error?.message ?? String(error),
        });
      }
    return true;
  }
  /** Claim and acknowledge only at the final model-visible boundary. */
  drain() {
    this.prune();
    const now = this.now();
    const items = this.items.filter((item) => (item.eligibleAt ?? 0) <= now);
    const dropped = this.dropped;
    this.items = this.items.filter((item) => (item.eligibleAt ?? 0) > now);
    this.bytes = this.items.reduce((sum, item) => sum + item.bytes, 0);
    this.dropped = { overflow: 0, expired: 0 };
    const deliveryErrors = [];
    for (const item of items) {
      this.settle(item.id, "delivered");
      try {
        item.onDelivered?.();
      } catch (error) {
        const detail = {
          id: item.id,
          message: error?.message ?? String(error),
        };
        deliveryErrors.push(detail);
        try {
          this.emit("deliveryError", detail);
        } catch (listenerError) {
          deliveryErrors.push({
            id: item.id,
            stage: "error-listener",
            message: listenerError?.message ?? String(listenerError),
          });
        }
      }
    }
    return {
      sessionId: this.sessionId,
      messages: items.map((x) => x.message),
      dropped,
      totalDropped: { ...this.totalDropped },
      ...(deliveryErrors.length ? { deliveryErrors } : {}),
    };
  }
  get pending() {
    this.prune();
    return (
      this.items.some((item) => (item.eligibleAt ?? 0) <= this.now()) ||
      this.dropped.overflow > 0 ||
      this.dropped.expired > 0
    );
  }
}

/**
 * The InboxClient interface (send/post/upsert/requestJudgment/delivery) over
 * an in-process Inbox, for tests and single-process tools.
 */
export function localInboxClient(inbox, { source = "program" } = {}) {
  const send = async (message) =>
    inbox.post({ ...message, sessionId: inbox.sessionId }, { source });
  return {
    sessionId: inbox.sessionId,
    send,
    post: (data, options = {}) => send({ ...options, kind: "event", data }),
    upsert: (key, data, options = {}) =>
      send({ ...options, kind: "state", key, data }),
    requestJudgment: (data, options = {}) =>
      send({ ...options, kind: "judgment", data, priority: "urgent" }),
    setStatus: (key, data, options = {}) =>
      send({ ...options, kind: "current", key, data }),
    async delivery(id, { timeoutMs = 30000 } = {}) {
      return { id, outcome: await inbox.waitForOutcome(id, timeoutMs) };
    },
  };
}
