import test from "node:test";
import assert from "node:assert/strict";
import {
  budgetFromHeaders,
  budgetFromSnapshot,
  sanitizeCashRatios,
} from "../packages/pi-extension/budget-feedback.mjs";

function cash(overrides = {}) {
  return {
    mode: "ratios-only",
    basis: "official-api-list-price-reference",
    coverage: "current-window-priced-usage-only",
    quality: "partial",
    costShare: {
      uncachedInput: 0.5,
      cachedInput: 0.125,
      output: 0.375,
      amount: "HOST_AMOUNT_SENTINEL",
    },
    rate: {
      windowMs: 60000,
      windowLoadRatio: 1.2,
      overRateRatioBeforeWait: 0.4,
      queueDelayMs: 250,
      currencyRate: "HOST_AMOUNT_SENTINEL",
    },
    calls: {
      priced: 4,
      estimated: 1,
      unknown: 2,
      price: "HOST_AMOUNT_SENTINEL",
    },
    enforcement: "cash-rate-queue",
    amount: "HOST_AMOUNT_SENTINEL",
    currency: "HOST_AMOUNT_SENTINEL",
    price: "HOST_AMOUNT_SENTINEL",
    spentToTargetRatio: 45,
    overrunRatio: 44,
    targetAmount: "HOST_AMOUNT_SENTINEL",
    purposeShare: { mainAgent: 0.8, summarization: 0.2 },
    ...overrides,
  };
}
function assertPrivateFieldsAbsent(value) {
  const text = JSON.stringify(value);
  assert.doesNotMatch(
    text,
    /HOST_AMOUNT_SENTINEL|spentToTargetRatio|overrunRatio|targetAmount|purposeShare|mainAgent|summarization|currencyRate/,
  );
  function visit(node) {
    if (!node || typeof node !== "object") return;
    for (const [key, val] of Object.entries(node)) {
      assert.ok(
        ![
          "amount",
          "currency",
          "price",
          "unitPrice",
          "pricing",
          "rates",
        ].includes(key),
        `private key ${key} was copied`,
      );
      visit(val);
    }
  }
  visit(value);
}

test("cash projector retains only billing shares, projected window ratios and known estimate status", () => {
  const result = sanitizeCashRatios(cash());
  assert.deepEqual(result, {
    mode: "ratios-only",
    quality: "partial",
    rate: {
      windowMs: 60000,
      windowLoadRatio: 1.2,
      overRateRatioBeforeWait: 0.4,
      queueDelayMs: 250,
    },
    costShare: { uncachedInput: 0.5, cachedInput: 0.125, output: 0.375 },
    calls: { priced: 4, estimated: 1, unknown: 2 },
    basis: "official-api-list-price-reference",
    coverage: "current-window-priced-usage-only",
    enforcement: "cash-rate-queue",
  });
  assertPrivateFieldsAbsent(result);
});

test("headers and active snapshots apply the same explicit privacy allowlist", () => {
  const headers = budgetFromHeaders({
    "X-Arena-Cash-Ratios": JSON.stringify({
      participant: cash(),
      team: cash({ quality: "estimated" }),
      amount: "HOST_AMOUNT_SENTINEL",
    }),
    "X-Arena-Queue-Delay-Ms": "250",
    "X-Arena-Reserved-Tokens": "2048",
    "X-Arena-Participant-Remaining-Tokens": "8000",
    "X-Arena-Team-Remaining-Tokens": "16000",
    "X-Arena-Amount": "HOST_AMOUNT_SENTINEL",
    "X-Arena-Currency": "HOST_AMOUNT_SENTINEL",
  });
  const snapshot = budgetFromSnapshot({
    participant: {
      remainingTokens: 7900,
      cash: cash(),
      amount: "HOST_AMOUNT_SENTINEL",
      pricing: cash(),
    },
    team: {
      remainingTokens: 15900,
      cash: cash({ quality: "estimated" }),
      currency: "HOST_AMOUNT_SENTINEL",
    },
    lastRequest: {
      queueDelayMs: 250,
      reservedTokens: 2048,
      unitPrice: "HOST_AMOUNT_SENTINEL",
    },
    amount: "HOST_AMOUNT_SENTINEL",
  });
  for (const result of [headers, snapshot]) {
    assertPrivateFieldsAbsent(result);
    assert.equal(result.cash.participant.quality, "partial");
    assert.equal(result.cash.team.quality, "estimated");
    assert.equal(result.cash.participant.rate.overRateRatioBeforeWait, 0.4);
    assert.match(result.accounting, /pre-wait projected pressure/);
    assert.match(result.accounting, /not cumulative spending/);
  }
  assert.equal(headers.participantRemainingTokens, 8000);
  assert.equal(snapshot.participantRemainingTokens, 7900);
});

test("unknown or malformed cash fields never become an amount or a fabricated purpose split", () => {
  assert.equal(sanitizeCashRatios(cash({ mode: "host-detail" })), undefined);
  assert.equal(
    sanitizeCashRatios(cash({ basis: "actual-invoice" })),
    undefined,
  );
  assert.equal(
    sanitizeCashRatios(cash({ coverage: "lifetime-priced-usage" })),
    undefined,
  );
  assert.equal(
    sanitizeCashRatios(cash({ enforcement: "report-only" })),
    undefined,
  );
  const invalid = sanitizeCashRatios(
    cash({
      quality: "HOST_AMOUNT_SENTINEL",
      rate: {
        windowMs: Infinity,
        windowLoadRatio: -1,
        overRateRatioBeforeWait: "HOST_AMOUNT_SENTINEL",
        queueDelayMs: null,
      },
      costShare: {
        uncachedInput: 2,
        cachedInput: -0.5,
        output: "HOST_AMOUNT_SENTINEL",
      },
    }),
  );
  assert.equal(invalid.quality, "unknown");
  assert.deepEqual(invalid.rate, {
    windowMs: null,
    windowLoadRatio: null,
    overRateRatioBeforeWait: null,
    queueDelayMs: null,
  });
  assert.deepEqual(invalid.costShare, {
    uncachedInput: null,
    cachedInput: null,
    output: null,
  });
  assertPrivateFieldsAbsent(invalid);
  assert.equal(budgetFromHeaders({ "x-arena-cash-ratios": "{" }), undefined);
  assert.equal(
    budgetFromHeaders({ "x-arena-cash-ratios": "x".repeat(20000) }),
    undefined,
  );
  assert.equal(budgetFromHeaders({ "x-arena-queue-delay-ms": "0" }), undefined);
});
