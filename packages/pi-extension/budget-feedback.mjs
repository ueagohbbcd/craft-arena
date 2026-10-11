/** Project the public budget contract. Never spread host data into model context. */
const QUALITIES = new Set([
  "exact",
  "estimated",
  "partial",
  "unknown",
  "no-usage",
]);
const finite = (value, max = Infinity) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= max
    ? value
    : undefined;
const ratio = (value, max = Infinity) => finite(value, max) ?? null;
const count = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : 0;
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function sanitizeCashRatios(value) {
  if (!record(value)) return undefined;
  return {
    mode: "ratios-only",
    quality: QUALITIES.has(value.quality) ? value.quality : "unknown",
    rate: {
      windowMs:
        typeof value.rate?.windowMs === "number" && value.rate.windowMs > 0
          ? ratio(value.rate.windowMs, Number.MAX_SAFE_INTEGER)
          : null,
      windowLoadRatio: ratio(value.rate?.windowLoadRatio),
      overRateRatioBeforeWait: ratio(value.rate?.overRateRatioBeforeWait),
      queueDelayMs: ratio(value.rate?.queueDelayMs),
    },
    costShare: {
      uncachedInput: ratio(value.costShare?.uncachedInput, 1),
      cachedInput: ratio(value.costShare?.cachedInput, 1),
      output: ratio(value.costShare?.output, 1),
    },
    calls: {
      priced: count(value.calls?.priced),
      estimated: count(value.calls?.estimated),
      unknown: count(value.calls?.unknown),
    },
    basis: "official-api-list-price-reference",
    coverage: "current-window-priced-usage-only",
    enforcement: "cash-rate-queue",
  };
}

function projectBudget({
  queueDelayMs,
  reservedTokens,
  participantRemainingTokens,
  teamRemainingTokens,
  participantCash,
  teamCash,
  accounting,
}) {
  const cash = {
    ...(participantCash ? { participant: participantCash } : {}),
    ...(teamCash ? { team: teamCash } : {}),
  };
  if (
    [reservedTokens, participantRemainingTokens, teamRemainingTokens].every(
      (x) => x === undefined,
    ) &&
    !(queueDelayMs > 0) &&
    !Object.keys(cash).length
  )
    return undefined;
  return {
    type: "arena.budget",
    accounting: [
      accounting,
      ...(reservedTokens === undefined
        ? []
        : [
            "requestReservedTokens is this request's reservation; final settled usage can differ",
          ]),
      ...(participantRemainingTokens === undefined &&
      teamRemainingTokens === undefined
        ? []
        : ["token remaining excludes in-flight reservations"]),
      ...(Object.keys(cash).length
        ? [
            "cash shares cover current-window priced usage at official API reference prices; rate ratios track repaid debt plus in-flight reservations and pre-wait projected pressure",
          ]
        : []),
    ].join("; "),
    ...(queueDelayMs > 0 ? { queueDelayMs } : {}),
    ...(reservedTokens === undefined
      ? {}
      : { requestReservedTokens: reservedTokens }),
    ...(participantRemainingTokens === undefined
      ? {}
      : { participantRemainingTokens }),
    ...(teamRemainingTokens === undefined ? {} : { teamRemainingTokens }),
    ...(Object.keys(cash).length ? { cash } : {}),
  };
}

export function budgetFromHeaders(input) {
  const headers = Object.fromEntries(
    Object.entries(input ?? {}).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  );
  const number = (key) => {
    const value = headers[key];
    if (typeof value !== "string" || !value.trim()) return undefined;
    return finite(Number(value));
  };
  let rawCash;
  const rawCashHeader = headers["x-arena-cash-ratios"];
  if (typeof rawCashHeader === "string" && rawCashHeader.length <= 16384) {
    try {
      rawCash = JSON.parse(rawCashHeader);
    } catch {
      /* Malformed optional feedback is ignored. */
    }
  }
  return projectBudget({
    queueDelayMs: number("x-arena-queue-delay-ms"),
    reservedTokens: number("x-arena-reserved-tokens"),
    participantRemainingTokens: number("x-arena-participant-remaining-tokens"),
    teamRemainingTokens: number("x-arena-team-remaining-tokens"),
    participantCash: sanitizeCashRatios(rawCash?.participant),
    teamCash: sanitizeCashRatios(rawCash?.team),
    accounting: "admission reservation snapshot",
  });
}

export function budgetFromSnapshot(input) {
  if (!record(input)) return undefined;
  return projectBudget({
    queueDelayMs: finite(input.lastRequest?.queueDelayMs),
    reservedTokens: finite(input.lastRequest?.reservedTokens),
    participantRemainingTokens: finite(input.participant?.remainingTokens),
    teamRemainingTokens: finite(input.team?.remainingTokens),
    participantCash: sanitizeCashRatios(input.participant?.cash),
    teamCash: sanitizeCashRatios(input.team?.cash),
    accounting: "authenticated budget snapshot",
  });
}
