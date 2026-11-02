import { test } from "node:test";
import assert from "node:assert/strict";
import { plan, nextAction, topupPacks, creditRateFromFarm, forecastBurn, DEFAULT_PARAMS, type Market } from "../src/policy.ts";
import { run, defaultScenario } from "../src/sim.ts";

const m: Market = { nearUsd: 2.5, apy: 0.045, commission: 0.05, creditUsdPerNearDay: creditRateFromFarm("3802570537683474") };

test("NEAR AI farm rate is $1 per 100 NEAR-months", () => {
  assert.ok(Math.abs(m.creditUsdPerNearDay * 30.4375 * 100 - 1) < 0.01);
});

test("steady state covers the burn exactly", () => {
  const p = plan({ totalNear: 100_000, aiNear: 0, creditUsd: 1_000, dailyUsageUsd: [10, 10, 10, 10, 10, 10, 10] }, m);
  assert.ok(Math.abs(p.steadyAiNear * m.creditUsdPerNearDay - 10) < 1e-9);
});

test("low buffer adds a refill on top of steady state", () => {
  const p = plan({ totalNear: 100_000, aiNear: 0, creditUsd: 0, dailyUsageUsd: [10, 10, 10] }, m);
  assert.ok(p.refillAiNear > 0);
  assert.ok(p.rawTargetAiNear > p.steadyAiNear);
});

test("target is clamped to the max AI share and coverage reports the gap", () => {
  const p = plan({ totalNear: 20_000, aiNear: 0, creditUsd: 0, dailyUsageUsd: [14.3] }, m);
  assert.equal(p.rawTargetAiNear, 20_000 * DEFAULT_PARAMS.maxAiShare);
  assert.ok(p.coverage < 0.5);
});

test("small drift does not move", () => {
  const steady = 10 / m.creditUsdPerNearDay;
  const B = DEFAULT_PARAMS.bufferDays * 10;
  const p = plan({ totalNear: 100_000, aiNear: steady * 1.02, creditUsd: B * 1.2, dailyUsageUsd: [10, 10, 10] }, m);
  assert.equal(p.move, false);
});

test("trims only with a full double buffer", () => {
  const big = { totalNear: 100_000, aiNear: 90_000, dailyUsageUsd: [5, 5, 5] };
  assert.equal(plan({ ...big, creditUsd: 20 }, m).move, false);
  const p = plan({ ...big, creditUsd: 100 }, m);
  assert.equal(p.move, true);
  assert.ok(p.targetAiNear < 90_000);
});

test("emergency when runway is shorter than the unbond", () => {
  const p = plan({ totalNear: 100_000, aiNear: 1_000, creditUsd: 5, dailyUsageUsd: [20, 20] }, m);
  assert.equal(p.emergency, true);
  assert.equal(p.move, true);
});

test("forecast reacts to a spike", () => {
  assert.ok(forecastBurn([10, 10, 10, 10, 20]) >= 15);
});

test("nextAction: stake liquid into AI first, then the rest to yield", () => {
  const books = { liquid: 100, aiStaked: 0, aiUnstaking: 0, aiWithdrawable: 0, yieldStaked: 0, yieldUnstaking: 0, yieldCanWithdraw: false };
  assert.deepEqual(nextAction(books, 60), { kind: "StakeAi", amount: 60 });
  assert.deepEqual(nextAction({ ...books, liquid: 40, aiStaked: 60 }, 60), { kind: "StakeYield", amount: 40 });
});

test("nextAction: free yield NEAR when AI needs more, but not twice", () => {
  const books = { liquid: 0, aiStaked: 60, aiUnstaking: 0, aiWithdrawable: 0, yieldStaked: 40, yieldUnstaking: 0, yieldCanWithdraw: false };
  assert.deepEqual(nextAction(books, 70), { kind: "UnstakeYield", amount: 10 });
  assert.equal(nextAction({ ...books, yieldStaked: 30, yieldUnstaking: 10 }, 70), null);
  assert.deepEqual(nextAction({ ...books, yieldStaked: 30, yieldUnstaking: 10, yieldCanWithdraw: true }, 70), { kind: "WithdrawYield", amount: 10 });
});

test("nextAction: unstake AI above target, and collect withdrawable NEAR", () => {
  const books = { liquid: 0, aiStaked: 60, aiUnstaking: 0, aiWithdrawable: 0, yieldStaked: 40, yieldUnstaking: 0, yieldCanWithdraw: false };
  assert.deepEqual(nextAction(books, 50), { kind: "UnstakeAi", amount: 10 });
  assert.deepEqual(nextAction({ ...books, aiUnstaking: 10, aiWithdrawable: 10 }, 50), { kind: "WithdrawAi" });
});

test("simulator: Ballast avoids throttling that set-and-forget suffers, and out-earns all-in AI", () => {
  const sc = defaultScenario();
  const b = run(sc, "ballast");
  const s = run(sc, "static");
  const a = run(sc, "all-ai");
  assert.equal(b.throttledHours, 0);
  assert.ok(s.throttledHours > 0);
  assert.ok(b.yieldEarnedNear > a.yieldEarnedNear + 50);
});

test("nextAction: gas headroom limits stakes but not the yield unstake the vault allows", () => {
  const books = { liquid: 2.3, aiStaked: 7, aiUnstaking: 0, aiWithdrawable: 0, yieldStaked: 2.657, yieldUnstaking: 0, yieldCanWithdraw: false };
  assert.deepEqual(nextAction(books, 9.3, 1, 0.5, 0.6), { kind: "StakeAi", amount: 2.3 - 0.6 });
  // 0.6 liquid left and a 0.6 gap: the vault counts that liquid, so no yield unstake and nothing to do.
  assert.equal(nextAction({ ...books, liquid: 0.6, aiStaked: 8.7 }, 9.3, 1, 0.5, 0.6), null);
});

test("topupPacks: covers the shortfall until new stake lands, within what the vault allows", () => {
  const obs = { totalNear: 100_000, aiNear: 1_000, creditUsd: 5, dailyUsageUsd: [20, 20] };
  const p = plan(obs, m);
  assert.equal(p.emergency, true);
  const days = DEFAULT_PARAMS.unlockDays + 1;
  const shortfall = days * (p.burnUsdDay - m.creditUsdPerNearDay * 1_000) - 5;
  const packs = topupPacks(p, obs, m, DEFAULT_PARAMS, 1, 1_000);
  assert.equal(packs, Math.ceil(shortfall / m.nearUsd));
  assert.equal(topupPacks(p, obs, m, DEFAULT_PARAMS, 1, 3), 3, "limited by the vault's allowance");
  const calm = plan({ ...obs, aiNear: 90_000, creditUsd: 500 }, m);
  assert.equal(topupPacks(calm, { ...obs, aiNear: 90_000, creditUsd: 500 }, m, DEFAULT_PARAMS, 1, 1_000), 0);
});

import { digestOf, type LogEntry } from "../src/log.ts";

test("digest: covered usage, earned yield and the moves in the window", () => {
  const base: LogEntry = {
    t: Date.UTC(2026, 10, 2), totalNear: 60_000, aiNear: 40_000, yieldValueNear: 20_000, yieldEarnedNear: 0,
    creditUsd: 50, spentUsd: 0, earnedUsd: 50, burnUsdDay: 14, runwayDays: null, targetAiNear: 40_000, actions: [],
  };
  const later: LogEntry = {
    ...base, t: base.t + 3 * 86_400_000, aiNear: 41_800, yieldEarnedNear: 2.1, spentUsd: 100, earnedUsd: 146, creditUsd: 46,
    actions: [{ kind: "rebalance", tx: "abc", ok: true, fromNear: 40_000, toNear: 41_800, reason: "usage spiked" }],
  };
  const d = digestOf([base, later], 7, 2.5);
  assert.match(d, /Covered \$100\.00 of \$100\.00 in usage \(100%\); earned 2\.1000 NEAR/);
  assert.match(d, /Moved 1800 NEAR toward AI \(AI target 40000 → 41800\) on Thursday,? 5 Nov: usage spiked/);
});
