export class BudgetError extends Error {
  constructor(message, status = 429) {
    super(message);
    this.status = status;
  }
}
/** Atomic in-process accounting. Exactly one gateway instance owns a match. */
export class BudgetLedger {
  constructor({
    participants,
    teams,
    now = Date.now,
    windowMs = 60_000,
    autoWake = true,
  }) {
    this.now = now;
    this.windowMs = windowMs;
    this.autoWake = autoWake;
    this.participants = new Map(
      Object.entries(participants).map(([id, x]) => [
        id,
        { ...x, used: 0, active: 0, windows: [] },
      ]),
    );
    this.teams = new Map(
      Object.entries(teams).map(([id, x]) => [
        id,
        { ...x, used: 0, active: 0, windows: [] },
      ]),
    );
    for (const [id, p] of this.participants) {
      if (!this.teams.has(p.team)) throw new Error(`Unknown team for ${id}`);
    }
    for (const x of [...this.participants.values(), ...this.teams.values()]) {
      for (const key of ["tokens", "tpm", "concurrency"])
        if (
          !(key === "tokens" && x[key] === null) &&
          (!Number.isSafeInteger(x[key]) || x[key] <= 0)
        )
          throw new Error(`Invalid ${key}`);
    }
    this.queue = [];
    this.timer = null;
    this.closed = false;
  }
  accounts(id) {
    const p = this.participants.get(id);
    if (!p) throw new BudgetError("Unknown participant", 403);
    return [p, this.teams.get(p.team)];
  }
  clean(a) {
    a.windows = a.windows.filter(
      (x) => x.active || x.at + this.windowMs > this.now(),
    );
  }
  acquire(id, tokens, { signal } = {}) {
    if (this.closed)
      return Promise.reject(new BudgetError("Ledger closed", 503));
    if (!Number.isSafeInteger(tokens) || tokens <= 0)
      return Promise.reject(new BudgetError("Invalid reservation", 400));
    let accounts;
    try {
      accounts = this.accounts(id);
    } catch (e) {
      return Promise.reject(e);
    }
    if (
      accounts.some(
        (a) => tokens > a.tpm || (a.tokens !== null && tokens > a.tokens),
      )
    )
      return Promise.reject(
        new BudgetError("Request exceeds maximum budget or TPM"),
      );
    if (signal?.aborted)
      return Promise.reject(new BudgetError("Cancelled", 499));
    return new Promise((resolve, reject) => {
      const q = {
        id,
        accounts,
        tokens,
        at: this.now(),
        resolve,
        reject,
        signal,
      };
      q.cancel = () => {
        const i = this.queue.indexOf(q);
        if (i < 0) return;
        this.queue.splice(i, 1);
        reject(new BudgetError("Cancelled", 499));
        this.tick();
      };
      signal?.addEventListener("abort", q.cancel, { once: true });
      this.queue.push(q);
      this.tick();
    });
  }
  tick() {
    clearTimeout(this.timer);
    this.timer = null;
    // FIFO within shared accounts; independent teams may pass a blocked team.
    const blocked = new Set();
    for (const q of [...this.queue]) {
      q.accounts.forEach((a) => this.clean(a));
      if (
        q.accounts.some(
          (a) => a.tokens !== null && a.used + q.tokens > a.tokens,
        )
      ) {
        this.remove(q);
        q.reject(new BudgetError("Token budget exhausted"));
        continue;
      }
      if (
        q.accounts.some(
          (a) =>
            blocked.has(a) ||
            a.active >= a.concurrency ||
            a.windows.reduce((n, x) => n + x.tokens, 0) + q.tokens > a.tpm,
        )
      ) {
        q.accounts.forEach((a) => blocked.add(a));
        continue;
      }
      this.remove(q);
      const entries = q.accounts.map((a) => {
        const e = { at: this.now(), tokens: q.tokens, active: true };
        a.used += q.tokens;
        a.active++;
        a.windows.push(e);
        return e;
      });
      let settled = false;
      q.resolve({
        reservedTokens: q.tokens,
        queueDelayMs: this.now() - q.at,
        settle: (actual) => {
          if (settled) return false;
          settled = true;
          // Missing/invalid usage (disconnect, provider error) charges the full reservation.
          const charge =
            Number.isSafeInteger(actual) && actual >= 0 ? actual : q.tokens;
          q.accounts.forEach((a, i) => {
            a.used += charge - q.tokens;
            a.active--;
            entries[i].tokens = charge;
            entries[i].active = false;
            entries[i].at = this.now();
          });
          this.tick();
          return true;
        },
      });
    }
    if (this.queue.length && this.autoWake) {
      const expiries = [
        ...this.participants.values(),
        ...this.teams.values(),
      ].flatMap((a) =>
        a.windows.filter((e) => !e.active).map((e) => e.at + this.windowMs),
      );
      if (expiries.length)
        this.timer = setTimeout(
          () => this.tick(),
          Math.max(1, Math.min(...expiries) - this.now()),
        );
    }
  }
  remove(q) {
    this.queue.splice(this.queue.indexOf(q), 1);
    q.signal?.removeEventListener("abort", q.cancel);
  }
  snapshot(id) {
    return this.accounts(id).map((a) => {
      this.clean(a);
      const reservedTokens = a.windows
        .filter((e) => e.active)
        .reduce((n, e) => n + e.tokens, 0);
      return {
        limits: { tokens: a.tokens, tpm: a.tpm, concurrency: a.concurrency },
        reservedTokens,
        settledTokens: a.used - reservedTokens,
        usedTokens: a.used,
        remainingTokens:
          a.tokens === null ? null : Math.max(0, a.tokens - a.used),
        overrunTokens: a.tokens === null ? 0 : Math.max(0, a.used - a.tokens),
        active: a.active,
        rollingTokens: a.windows.reduce((n, x) => n + x.tokens, 0),
      };
    });
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    for (const q of [...this.queue]) {
      this.remove(q);
      q.reject(new BudgetError("Ledger closed", 503));
    }
  }
}

/** Cost-rate bucket. A request may exceed one window; settled debt drains at the configured rate. */
export class CashRateLedger {
  constructor({
    participants,
    teams,
    now = Date.now,
    windowMs = 60_000,
    autoWake = true,
  }) {
    if (!Number.isSafeInteger(windowMs) || windowMs <= 0)
      throw new Error("Invalid cash rate window");
    this.now = now;
    this.windowMs = windowMs;
    this.scale = BigInt(windowMs);
    this.autoWake = autoWake;
    const accounts = (values) =>
      new Map(
        Object.entries(values).map(([id, x]) => {
          if (
            !Number.isSafeInteger(x.tpm) ||
            x.tpm <= 0 ||
            !Number.isSafeInteger(x.concurrency) ||
            x.concurrency <= 0
          )
            throw new Error("Invalid cash rate/concurrency");
          return [
            id,
            { ...x, used: 0, active: 0, reserved: 0, debt: 0n, at: now() },
          ];
        }),
      );
    this.participants = accounts(participants);
    this.teams = accounts(teams);
    for (const [id, p] of this.participants)
      if (!this.teams.has(p.team)) throw new Error(`Unknown team for ${id}`);
    this.queue = [];
    this.timer = null;
    this.closed = false;
  }
  accounts(id) {
    const p = this.participants.get(id);
    if (!p) throw new BudgetError("Unknown participant", 403);
    return [p, this.teams.get(p.team)];
  }
  clean(a) {
    const at = Math.max(a.at, this.now());
    const paid = BigInt(at - a.at) * BigInt(a.tpm);
    a.debt = a.debt > paid ? a.debt - paid : 0n;
    a.at = at;
  }
  load(a) {
    return a.debt + BigInt(a.reserved) * this.scale;
  }
  acquire(id, units, { signal } = {}) {
    if (this.closed)
      return Promise.reject(new BudgetError("Ledger closed", 503));
    if (!Number.isSafeInteger(units) || units <= 0)
      return Promise.reject(new BudgetError("Invalid reservation", 400));
    let accounts;
    try {
      accounts = this.accounts(id);
    } catch (e) {
      return Promise.reject(e);
    }
    if (signal?.aborted)
      return Promise.reject(new BudgetError("Cancelled", 499));
    return new Promise((resolve, reject) => {
      const q = { accounts, units, signal, resolve, reject, at: this.now() };
      q.cancel = () => {
        if (!this.queue.includes(q)) return;
        this.remove(q);
        reject(new BudgetError("Cancelled", 499));
        this.tick();
      };
      signal?.addEventListener("abort", q.cancel, { once: true });
      this.queue.push(q);
      this.tick();
    });
  }
  tick() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.closed) return;
    // FIFO within each participant/team; unrelated teams can pass blocked accounts.
    const blocked = new Set();
    for (const q of [...this.queue]) {
      q.accounts.forEach((a) => this.clean(a));
      if (
        q.accounts.some(
          (a) =>
            blocked.has(a) ||
            a.active >= a.concurrency ||
            this.load(a) >= BigInt(a.tpm) * this.scale,
        )
      ) {
        q.accounts.forEach((a) => blocked.add(a));
        continue;
      }
      this.remove(q);
      // Large quotes occupy at most a full bucket until actual usage is known.
      // Reservations never decay: slow or missing provider responses cannot open more slots.
      const reserved = q.accounts.map((a) => Math.min(q.units, a.tpm));
      q.accounts.forEach((a, i) => {
        a.reserved += reserved[i];
        a.used += reserved[i];
        a.active++;
      });
      let settled = false;
      q.resolve({
        queueDelayMs: this.now() - q.at,
        settle: (actual) => {
          if (settled) return false;
          settled = true;
          const charge =
            Number.isSafeInteger(actual) && actual >= 0 ? actual : q.units;
          q.accounts.forEach((a, i) => {
            this.clean(a);
            a.reserved -= reserved[i];
            a.used += charge - reserved[i];
            a.active--;
            a.debt += BigInt(charge) * this.scale;
          });
          this.tick();
          return true;
        },
      });
    }
    if (this.queue.length && this.autoWake) {
      const waits = [
        ...this.participants.values(),
        ...this.teams.values(),
      ].flatMap((a) => {
        this.clean(a);
        const excess = this.load(a) - BigInt(a.tpm) * this.scale;
        // A full in-flight bucket requires settlement rather than a timer.
        if (a.reserved >= a.tpm || excess < 0n) return [];
        return [Number(excess / BigInt(a.tpm)) + 1];
      });
      if (waits.length)
        this.timer = setTimeout(
          () => this.tick(),
          Math.min(2_147_483_647, Math.max(1, Math.min(...waits))),
        );
    }
  }
  remove(q) {
    this.queue.splice(this.queue.indexOf(q), 1);
    q.signal?.removeEventListener("abort", q.cancel);
  }
  snapshot(id) {
    return this.accounts(id).map((a) => {
      this.clean(a);
      return {
        limits: { tokens: null, tpm: a.tpm, concurrency: a.concurrency },
        reservedTokens: a.reserved,
        settledTokens: a.used - a.reserved,
        usedTokens: a.used,
        remainingTokens: null,
        overrunTokens: 0,
        active: a.active,
        rollingTokens: Number(this.load(a)) / this.windowMs,
      };
    });
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = null;
    for (const q of [...this.queue]) {
      this.remove(q);
      q.reject(new BudgetError("Ledger closed", 503));
    }
  }
}
