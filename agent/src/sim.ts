// Simulator: runs the vault, both staking sides, the credit meter and the agent hour by hour with accelerated
// epochs, and compares Ballast with doing nothing clever. Deterministic for a given seed.
import { plan, nextAction, DEFAULT_PARAMS, yieldUsdPerNearDay, type Market, type PolicyParams, type VaultBooks } from "./policy.ts";

export interface Scenario {
  days: number;
  vaultNear: number;
  budgetUsdWeek: number; // what the user says they spend
  spikeDay: number; // usage multiplier starts on this day (0 = never)
  spikeMultiplier: number;
  spikeEndDay: number; // multiplier stops on this day (0 = lasts to the end)
  startCreditsUsd: number;
  epochHours: number;
  unbondEpochs: number;
  market: Market;
  params: PolicyParams;
  seed: number;
}

export const NEAR_AI_FARM_RATE = "3802570537683474"; // NEAR AI testnet config: $100 NEAR x 1 month = $1 credit

export function defaultScenario(): Scenario {
  return {
    days: 30,
    vaultNear: 100_000,
    budgetUsdWeek: 100,
    spikeDay: 10,
    spikeMultiplier: 2,
    spikeEndDay: 20,
    startCreditsUsd: 25,
    epochHours: 7,
    unbondEpochs: 4,
    market: {
      nearUsd: 2.5,
      apy: 0.045,
      commission: 0.05,
      creditUsdPerNearDay: (Number(BigInt(NEAR_AI_FARM_RATE)) / 1e24) * 86_400,
    },
    params: { ...DEFAULT_PARAMS, unlockDays: (7 * 4) / 24, burnFloorUsdDay: 0 },
    seed: 7,
  };
}

export type Strategy = "ballast" | "all-ai" | "static";

export interface Hour {
  t: number; // hour index
  demandUsd: number;
  servedUsd: number;
  creditsUsd: number;
  aiNear: number;
  yieldNear: number;
  inFlightNear: number;
  liquidNear: number;
  runwayDays: number;
}

export interface SimEvent {
  t: number;
  kind: string;
  detail: string;
}

export interface Result {
  strategy: Strategy;
  hours: Hour[];
  events: SimEvent[];
  unmetUsd: number;
  throttledHours: number;
  yieldEarnedNear: number;
  endCreditsUsd: number;
  avgAiShare: number;
  moves: number;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Hourly demand in dollars: a daytime curve with noise, scaled to the weekly budget, with an optional spike. */
export function demandSeries(sc: Scenario): number[] {
  const r = rng(sc.seed);
  const perDay = sc.budgetUsdWeek / 7;
  const out: number[] = [];
  for (let h = 0; h < sc.days * 24; h++) {
    const day = Math.floor(h / 24);
    const hod = h % 24;
    const shape = 0.35 + Math.max(0, Math.sin(((hod - 6) / 16) * Math.PI)) * 1.55; // mean ~1
    const noise = 0.7 + r() * 0.6;
    const spiking = sc.spikeDay > 0 && day >= sc.spikeDay && (sc.spikeEndDay === 0 || day < sc.spikeEndDay);
    out.push((perDay / 24) * shape * noise * (spiking ? sc.spikeMultiplier : 1));
  }
  return out;
}

interface Tranche {
  amount: number;
  readyAt: number; // hour
}

export function run(sc: Scenario, strategy: Strategy): Result {
  const m = sc.market;
  const c = m.creditUsdPerNearDay;
  const yHourly = (m.apy * (1 - m.commission)) / (365 * 24);
  const demand = demandSeries(sc);
  const unbondHours = sc.unbondEpochs * sc.epochHours;

  let liquid = sc.vaultNear;
  let ai = 0;
  let yld = 0;
  const aiOut: Tranche[] = [];
  const yldOut: Tranche[] = [];
  let credits = sc.startCreditsUsd;
  let unmet = 0;
  let throttled = 0;
  let yieldEarned = 0;
  let aiShareSum = 0;
  let moves = 0;
  let target = 0;
  const hours: Hour[] = [];
  const events: SimEvent[] = [];
  const pending = (q: Tranche[]) => q.reduce((s, x) => s + x.amount, 0);

  const statedSteady = sc.budgetUsdWeek / 7 / c;
  if (strategy === "all-ai") {
    ai = liquid;
    liquid = 0;
  } else if (strategy === "static") {
    ai = Math.min(statedSteady, sc.vaultNear * sc.params.maxAiShare);
    yld = sc.vaultNear - ai;
    liquid = 0;
  }

  const recentDaily = (h: number) => {
    // Rolling 24h windows ending now, oldest first: fresh signal without waiting for midnight.
    const days: number[] = [];
    for (let end = h; end > 0 && days.length < 14; end -= 24) {
      const start = Math.max(0, end - 24);
      const sum = demand.slice(start, end).reduce((a, b) => a + b, 0);
      days.unshift((sum * 24) / (end - start));
    }
    return days;
  };

  for (let h = 0; h < sc.days * 24; h++) {
    // Unbonded NEAR lands as liquid.
    for (const q of [aiOut, yldOut]) {
      for (let i = q.length - 1; i >= 0; i--) {
        if (q[i].readyAt <= h) {
          liquid += q[i].amount;
          q.splice(i, 1);
        }
      }
    }

    if (strategy === "ballast" && h % sc.epochHours === 0) {
      const total = liquid + ai + yld + pending(aiOut) + pending(yldOut);
      const daily = recentDaily(h);
      const p = plan(
        { totalNear: total, aiNear: ai, creditUsd: credits, dailyUsageUsd: daily.length ? daily : [sc.budgetUsdWeek / 7] },
        m,
        { ...sc.params, burnFloorUsdDay: sc.budgetUsdWeek / 7 },
      );
      if (p.move && Math.abs(p.targetAiNear - target) > 1e-6) {
        events.push({ t: h, kind: "rebalance", detail: `target ${Math.round(p.targetAiNear)} NEAR (${p.reason})` });
        target = p.targetAiNear;
        moves++;
      } else if (h === 0) target = ai;
      // Execute steps toward target, as the agent would with one transaction each.
      for (let i = 0; i < 6; i++) {
        const books: VaultBooks = {
          liquid,
          aiStaked: ai,
          aiUnstaking: pending(aiOut),
          aiWithdrawable: 0,
          yieldStaked: yld,
          yieldUnstaking: pending(yldOut),
          yieldCanWithdraw: false,
        };
        const a = nextAction(books, target);
        if (!a || a.kind === "WithdrawAi" || a.kind === "WithdrawYield") break;
        if (a.kind === "StakeAi") { liquid -= a.amount; ai += a.amount; }
        if (a.kind === "StakeYield") { liquid -= a.amount; yld += a.amount; }
        if (a.kind === "UnstakeAi") { ai -= a.amount; aiOut.push({ amount: a.amount, readyAt: h + unbondHours }); }
        if (a.kind === "UnstakeYield") { yld -= a.amount; yldOut.push({ amount: a.amount, readyAt: h + unbondHours }); }
        events.push({ t: h, kind: a.kind, detail: `${Math.round(a.amount)} NEAR` });
      }
    }

    // Accrual: credits on the AI side, NEAR rewards on the yield side.
    credits += (c * ai) / 24;
    const r = yld * yHourly;
    yld += r;
    yieldEarned += r;

    // Usage.
    const d = demand[h];
    const served = Math.min(d, credits);
    credits -= served;
    if (d - served > 1e-9) {
      unmet += d - served;
      throttled++;
    }
    const total = liquid + ai + yld + pending(aiOut) + pending(yldOut);
    aiShareSum += ai / total;
    const net = d * 24 - c * ai;
    hours.push({
      t: h,
      demandUsd: d,
      servedUsd: served,
      creditsUsd: credits,
      aiNear: ai,
      yieldNear: yld,
      inFlightNear: pending(aiOut) + pending(yldOut),
      liquidNear: liquid,
      runwayDays: net <= 0 ? 99 : Math.min(99, credits / net),
    });
  }

  return {
    strategy,
    hours,
    events,
    unmetUsd: unmet,
    throttledHours: throttled,
    yieldEarnedNear: yieldEarned,
    endCreditsUsd: credits,
    avgAiShare: aiShareSum / hours.length,
    moves,
  };
}

export function compare(sc: Scenario) {
  return (["ballast", "static", "all-ai"] as Strategy[]).map((s) => run(sc, s));
}

export { yieldUsdPerNearDay };
