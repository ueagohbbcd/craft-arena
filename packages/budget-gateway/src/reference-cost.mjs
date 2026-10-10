import { randomUUID } from "node:crypto";
import { BudgetLedger, BudgetError } from "./ledger.mjs";
/** Official-list-price reference cost, never an invoice. One currency unit = 10^12 integer pico-units. */
const SCALE = 1_000_000_000_000n;
function decimal(value, digits, label) {
  if (
    typeof value !== "string" ||
    !new RegExp(`^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,${digits}})?$`).test(value)
  )
    throw new Error(`Invalid ${label}; use nonnegative decimal string`);
  const [w, f = ""] = value.split(".");
  return BigInt(w) * 10n ** BigInt(digits) + BigInt(f.padEnd(digits, "0"));
}
const amount = (v) => {
  const f = (v % SCALE).toString().padStart(12, "0").replace(/0+$/, "");
  return `${v / SCALE}${f ? "." + f : ""}`;
};
const ratio = (a, b) =>
  b === 0n ? null : Number((a * 1_000_000_000n) / b) / 1_000_000_000;
const count = (x) => Number.isSafeInteger(x) && x >= 0;
const safeUnits = (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error(
      "Currency window/request exceeds supported integer precision",
    );
  return n;
};
const emptyCosts = () => ({ uncachedInput: 0n, cachedInput: 0n, output: 0n });
export class ReferenceCostLedger {
  constructor({
    config,
    participants,
    teams,
    models,
    now = Date.now,
    autoWake = true,
  }) {
    if (config?.mode !== "official-api-list-price")
      throw new Error("Unsupported reference cost mode");
    if (!/^[A-Z]{3}$/.test(config.currency ?? ""))
      throw new Error("Reference currency required");
    this.currency = config.currency;
    this.windowMs = config.windowMs ?? 60000;
    if (!Number.isSafeInteger(this.windowMs) || this.windowMs <= 0)
      throw new Error("Invalid cash rate window");
    this.now = now;
    this.prices = new Map();
    this.records = new Map();
    this.latest = new Map();
    this.participants = participants;
    this.teams = teams;
    for (const model of models) {
      const p = config.models?.[model];
      if (
        !p?.provider ||
        !/^https:\/\//.test(p.sourceUrl ?? "") ||
        !/^\d{4}-\d{2}-\d{2}$/.test(p.verifiedAt ?? "")
      )
        throw new Error(
          `Verified operator price metadata required for model ${model}`,
        );
      this.prices.set(model, {
        ...p,
        uncachedInput: decimal(p.inputPerMillion, 6, "input rate"),
        cachedInput: decimal(p.cachedInputPerMillion, 6, "cached input rate"),
        output: decimal(p.outputPerMillion, 6, "output rate"),
      });
    }
    const rateAccount = (a) => {
      const units = safeUnits(decimal(a.cashRateLimit, 12, "cash rate limit"));
      if (!units) throw new Error("Cash rate limit must be positive");
      return {
        team: a.team,
        tokens: null,
        tpm: units,
        concurrency: a.concurrency,
      };
    };
    this.rateLedger = new BudgetLedger({
      participants: Object.fromEntries(
        Object.entries(participants).map(([id, p]) => [id, rateAccount(p)]),
      ),
      teams: Object.fromEntries(
        Object.entries(teams).map(([id, t]) => [id, rateAccount(t)]),
      ),
      now,
      windowMs: this.windowMs,
      autoWake,
    });
  }
  quote(id, model, estimate) {
    const p = this.prices.get(model);
    if (!p) throw new Error("Missing configured model price");
    const units = safeUnits(
      BigInt(estimate.input) * p.uncachedInput +
        BigInt(estimate.output) * p.output,
    );
    if (units <= 0)
      throw new Error(
        "Zero-price reservation unsupported; use token-only mode for free models",
      );
    const accounts = this.rateLedger.snapshot(id);
    const pressure = accounts.map((a) =>
      Math.max(0, (a.rollingTokens + units - a.limits.tpm) / a.limits.tpm),
    );
    return { units, pressure, model };
  }
  assertFits(id, quote) {
    if (this.rateLedger.accounts(id).some((a) => quote.units > a.tpm)) {
      const e = new BudgetError(
        "Single request exceeds cash rate window; reduce request/output size",
        429,
      );
      this.noteWait(id, 0, quote);
      e.cashRatios = this.feedback(id, { quote, queueDelayMs: 0 });
      throw e;
    }
  }
  noteWait(id, ms, quote) {
    if (quote)
      this.latest.set(id, {
        pressure: quote.pressure,
        queueDelayMs: Math.max(0, ms),
      });
  }

  async acquire(id, quote, { signal, requestId = randomUUID() } = {}) {
    this.assertFits(id, quote);
    const reservation = await this.rateLedger.acquire(id, quote.units, {
      signal,
    });
    this.noteWait(id, reservation.queueDelayMs, quote);
    let settled = false;
    return {
      settle: (usage, { dispatched = true } = {}) => {
        if (settled) return false;
        settled = true;
        if (!dispatched) return reservation.settle(0);
        if (this.records.has(requestId)) {
          reservation.settle(0);
          return false;
        }
        const price = this.prices.get(quote.model),
          prompt = usage?.prompt_tokens,
          output = usage?.completion_tokens,
          cached = usage?.prompt_tokens_details?.cached_tokens;
        let quality = "unknown",
          tokens = null,
          costs = emptyCosts();
        if (
          count(prompt) &&
          count(output) &&
          (usage.total_tokens === undefined ||
            (count(usage.total_tokens) &&
              usage.total_tokens === prompt + output)) &&
          (cached === undefined || (count(cached) && cached <= prompt))
        ) {
          quality = cached === undefined ? "estimated" : "exact";
          tokens = {
            uncachedInput: prompt - (cached ?? 0),
            cachedInput: cached ?? 0,
            output,
          };
          for (const k of Object.keys(costs))
            costs[k] = BigInt(tokens[k]) * price[k];
        }
        const known = Object.values(costs).reduce((n, x) => n + x, 0n);
        let charged = quality === "unknown" ? quote.units : Number(known);
        if (!Number.isSafeInteger(charged)) {
          this.rateLedger.close();
          charged = Number.MAX_SAFE_INTEGER;
        }
        this.records.set(requestId, {
          requestId,
          participantId: id,
          team: this.participants[id].team,
          model: quote.model,
          at: this.now(),
          quality,
          tokens,
          costs,
          unknownEstimate: quality === "unknown" ? BigInt(quote.units) : 0n,
        });
        reservation.settle(charged);
        return true;
      },
    };
  }
  accountRecords(id, team = false, window = true) {
    return [...this.records.values()].filter(
      (r) =>
        (team
          ? r.team === this.participants[id].team
          : r.participantId === id) &&
        (!window || r.at + this.windowMs > this.now()),
    );
  }
  publicAccount(id, index, request) {
    const records = this.accountRecords(id, index === 1),
      costs = emptyCosts(),
      calls = { priced: 0, estimated: 0, unknown: 0 };
    for (const r of records) {
      for (const k of Object.keys(costs)) costs[k] += r.costs[k];
      if (r.quality === "unknown") calls.unknown++;
      else calls.priced++;
      if (r.quality === "estimated") calls.estimated++;
    }
    const total = Object.values(costs).reduce((n, x) => n + x, 0n),
      a = this.rateLedger.snapshot(id)[index],
      last = request?.quote
        ? {
            pressure: request.quote.pressure,
            queueDelayMs: request.queueDelayMs ?? 0,
          }
        : this.latest.get(id);
    return {
      mode: "ratios-only",
      basis: "official-api-list-price-reference",
      coverage: "current-window-priced-usage-only",
      quality: calls.unknown
        ? calls.priced
          ? "partial"
          : "unknown"
        : calls.estimated
          ? "estimated"
          : calls.priced
            ? "exact"
            : "no-usage",
      costShare: Object.fromEntries(
        Object.entries(costs).map(([k, v]) => [k, ratio(v, total)]),
      ),
      rate: {
        windowMs: this.windowMs,
        windowLoadRatio: a.rollingTokens / a.limits.tpm,
        overRateRatioBeforeWait: last?.pressure[index] ?? 0,
        queueDelayMs: last?.queueDelayMs ?? 0,
      },
      calls,
      enforcement: "cash-rate-queue",
    };
  }
  feedback(id, request) {
    return {
      participant: this.publicAccount(id, 0, request),
      team: this.publicAccount(id, 1, request),
    };
  }
  snapshot(id) {
    const f = this.feedback(id);
    return [f.participant, f.team];
  }
  operatorSnapshot(id) {
    return {
      currency: this.currency,
      basis: "official-api-list-price-reference",
      accounts: [false, true].map((team) => {
        const records = this.accountRecords(id, team, false),
          costs = emptyCosts();
        let unknown = 0n;
        for (const r of records) {
          for (const k of Object.keys(costs)) costs[k] += r.costs[k];
          unknown += r.unknownEstimate;
        }
        const total = Object.values(costs).reduce((n, x) => n + x, 0n);
        return {
          referenceCostPricedUsage: amount(total),
          unknownUsageReservationEstimate: amount(unknown),
          referenceCostIncludingUnknownEstimates: amount(total + unknown),
          costs: Object.fromEntries(
            Object.entries(costs).map(([k, v]) => [k, amount(v)]),
          ),
          requestCount: records.length,
        };
      }),
    };
  }
  close() {
    this.rateLedger.close();
  }
}
export function tokenUsageOnly(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const out = {};
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"])
    if (count(usage[key])) out[key] = usage[key];
  for (const [key, allowed] of [
    ["prompt_tokens_details", ["cached_tokens", "audio_tokens"]],
    [
      "completion_tokens_details",
      [
        "reasoning_tokens",
        "audio_tokens",
        "accepted_prediction_tokens",
        "rejected_prediction_tokens",
      ],
    ],
  ]) {
    if (usage[key] && typeof usage[key] === "object") {
      const value = {};
      for (const name of allowed)
        if (count(usage[key][name])) value[name] = usage[key][name];
      if (Object.keys(value).length) out[key] = value;
    }
  }
  return out;
}
const textField = (value) => typeof value === "string" || value === null;
function publicMessage(value) {
  if (!value || typeof value !== "object") return value === null ? null : {};
  const out = {};
  for (const key of ["role", "content", "refusal", "name", "tool_call_id"])
    if (textField(value[key])) out[key] = value[key];
  if (Array.isArray(value.tool_calls))
    out.tool_calls = value.tool_calls.map((call) => {
      const c = {};
      for (const key of ["id", "type"])
        if (typeof call[key] === "string") c[key] = call[key];
      if (count(call.index)) c.index = call.index;
      if (call.function && typeof call.function === "object") {
        c.function = {};
        for (const key of ["name", "arguments"])
          if (typeof call.function[key] === "string")
            c.function[key] = call.function[key];
      }
      return c;
    });
  return out;
}
export function publicProviderResponse(value) {
  if (!value || typeof value !== "object") return {};
  const out = {};
  for (const key of [
    "id",
    "object",
    "model",
    "service_tier",
    "system_fingerprint",
  ])
    if (textField(value[key])) out[key] = value[key];
  if (count(value.created)) out.created = value.created;
  if (Array.isArray(value.choices))
    out.choices = value.choices.map((choice) => {
      const c = {};
      if (count(choice.index)) c.index = choice.index;
      if (textField(choice.finish_reason))
        c.finish_reason = choice.finish_reason;
      for (const key of ["message", "delta"])
        if (choice[key] !== undefined) c[key] = publicMessage(choice[key]);
      return c;
    });
  if (value.error && typeof value.error === "object") {
    out.error = {};
    for (const key of ["message", "type", "code", "param"])
      if (textField(value.error[key])) out.error[key] = value.error[key];
  }
  if (value.usage !== undefined) out.usage = tokenUsageOnly(value.usage);
  return out;
}
