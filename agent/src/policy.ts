// Ballast's rebalancing logic. Pure functions, shared by the live agent and the simulator.
//
// Amounts here are plain numbers in whole NEAR and dollars: the agent converts to yoctoNEAR at the edge.

export interface Market {
  /** NEAR price in dollars. */
  nearUsd: number;
  /** Network staking APY before commission, e.g. 0.045. */
  apy: number;
  /** Yield-side validator commission, e.g. 0.05. */
  commission: number;
  /** NEAR AI credits accrued per staked NEAR per day, in dollars (from the farm's reward rate). */
  creditUsdPerNearDay: number;
}

export interface PolicyParams {
  minAiShare: number; // 0..1
  maxAiShare: number; // 0..1
  bufferDays: number; // target credit buffer, in days of burn
  refillDays: number; // spread a buffer refill over this many days
  /** Move only when the change exceeds both of these. */
  churnShare: number; // share of vault, e.g. 0.05
  churnNear: number; // absolute NEAR, e.g. 100
  /** Trim AI stake only when credits exceed this many buffers (trims are slow to undo). */
  trimAboveBuffers: number;
  /** Days it takes to move stake out of the AI side (unbond plus one day of margin is the emergency line). */
  unlockDays: number;
  /** User-stated floor for the burn forecast, $/day (manual mode sets this to budget/7). */
  burnFloorUsdDay: number;
}

export interface Observation {
  totalNear: number;
  aiNear: number; // NEAR currently earning credits
  creditUsd: number; // credit balance now
  /** Recent daily usage in dollars, oldest first (up to 7 days or more). */
  dailyUsageUsd: number[];
}

export interface Plan {
  burnUsdDay: number;
  steadyAiNear: number;
  bufferUsd: number;
  refillAiNear: number;
  targetAiNear: number; // after clamping and churn rules: what the agent should set
  rawTargetAiNear: number; // before churn rules
  runwayDays: number; // days until credits hit zero at the current AI stake
  coverage: number; // share of the forecast burn the max AI share can cover (1 = fully covered)
  emergency: boolean; // runway shorter than the time it takes to add stake
  move: boolean; // target differs enough from current to act
  reason: string;
}

/** Dollars with enough precision for both mainnet budgets and testnet-sized ones. */
export const usd = (v: number) => (Math.abs(v) >= 1 ? `$${v.toFixed(2)}` : `$${v.toPrecision(3)}`);
export const nearAmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(3));

export const DEFAULT_PARAMS: PolicyParams = {
  minAiShare: 0,
  maxAiShare: 0.9,
  // Tuned with the simulator (scripts in README): a 3-day buffer and 10% band avoid throttling in the
  // spike scenario while parking far less NEAR in credits than the 7-day buffer first proposed.
  bufferDays: 3,
  refillDays: 7,
  churnShare: 0.1,
  churnNear: 100,
  trimAboveBuffers: 2,
  unlockDays: 28 / 24, // 4 epochs of about 7 hours
  burnFloorUsdDay: 0,
};

/** Dollars of ordinary staking yield one NEAR earns per day, after commission. */
export function yieldUsdPerNearDay(m: Market): number {
  return (m.apy * (1 - m.commission) * m.nearUsd) / 365;
}

/** Farm reward rate (24-decimal units per second per NEAR) to $/NEAR/day, given $ per reward unit. */
export function creditRateFromFarm(rewardRate: string | bigint, usdPerRewardUnit = 1): number {
  return (Number(BigInt(rewardRate)) / 1e24) * 86_400 * usdPerRewardUnit;
}

/** Exponentially weighted average of daily usage; recent days weigh most. Half-life about 2.4 days. */
export function forecastBurn(daily: number[], alpha = 0.25): number {
  if (daily.length === 0) return 0;
  let f = daily[0];
  for (const d of daily.slice(1)) f = alpha * d + (1 - alpha) * f;
  // Never forecast below the latest day if usage is climbing: a spike should move us now, not in a week.
  return Math.max(f, daily[daily.length - 1] * 0.75);
}

export function plan(obs: Observation, m: Market, p: PolicyParams = DEFAULT_PARAMS): Plan {
  const c = m.creditUsdPerNearDay;
  const b = Math.max(forecastBurn(obs.dailyUsageUsd.slice(-14)), p.burnFloorUsdDay);
  const steady = b / c;
  const B = p.bufferDays * b;
  let refill = 0;
  if (obs.creditUsd < B) refill = (B - obs.creditUsd) / (p.refillDays * c);
  else if (obs.creditUsd > p.trimAboveBuffers * B) refill = -(obs.creditUsd - p.trimAboveBuffers * B) / (p.refillDays * c);

  const lo = p.minAiShare * obs.totalNear;
  const hi = p.maxAiShare * obs.totalNear;
  const raw = Math.min(hi, Math.max(lo, steady + refill));
  const net = b - c * obs.aiNear;
  const runway = net <= 0 ? Infinity : obs.creditUsd / net;
  const emergency = runway < p.unlockDays + 1;
  const coverage = b === 0 ? 1 : Math.min(1, (c * hi) / b);

  const diff = raw - obs.aiNear;
  const band = Math.max(p.churnShare * obs.totalNear, p.churnNear);
  let target = obs.aiNear;
  let reason = "within band";
  if (diff > 0 && (diff > band || emergency)) {
    target = raw;
    reason = emergency
      ? `runway ${runway.toFixed(1)}d is shorter than the ${(p.unlockDays + 1).toFixed(1)}d it takes to add stake`
      : `burn ${usd(b)}/day needs ${nearAmt(steady)} NEAR` +
        (refill > 0 ? ` plus ${nearAmt(refill)} to refill the ${p.bufferDays}-day buffer` : "");
  } else if (diff < 0 && -diff > band) {
    // Trimming AI stake is slow to undo (unbond), so only trim once the buffer is comfortably full.
    if (obs.creditUsd > p.trimAboveBuffers * B) {
      target = raw;
      reason = `credits ${usd(obs.creditUsd)} exceed ${p.trimAboveBuffers}x the buffer; returning ${nearAmt(-diff)} NEAR to yield`;
    } else reason = `would trim, but credits are not above ${p.trimAboveBuffers}x the buffer`;
  }
  return {
    burnUsdDay: b,
    steadyAiNear: steady,
    bufferUsd: B,
    refillAiNear: refill,
    targetAiNear: target,
    rawTargetAiNear: raw,
    runwayDays: runway,
    coverage,
    emergency,
    move: target !== obs.aiNear,
    reason,
  };
}

// ---------------------------------------------------------------- turning a target into vault actions

export interface VaultBooks {
  liquid: number;
  aiStaked: number;
  aiUnstaking: number;
  aiWithdrawable: number;
  yieldStaked: number;
  yieldUnstaking: number;
  yieldCanWithdraw: boolean;
}

export type Action =
  | { kind: "WithdrawAi" }
  | { kind: "WithdrawYield"; amount: number }
  | { kind: "StakeAi"; amount: number }
  | { kind: "UnstakeAi"; amount: number }
  | { kind: "StakeYield"; amount: number }
  | { kind: "UnstakeYield"; amount: number };

/** The single next step toward `target`, or null if there is nothing useful to do this epoch. */
export function nextAction(v: VaultBooks, target: number, minStake = 1, dust = 0.5): Action | null {
  if (v.aiWithdrawable > dust) return { kind: "WithdrawAi" };
  if (v.yieldUnstaking > dust && v.yieldCanWithdraw) return { kind: "WithdrawYield", amount: v.yieldUnstaking };
  const gap = target - v.aiStaked;
  if (gap >= minStake && v.liquid >= minStake) return { kind: "StakeAi", amount: Math.min(gap, v.liquid) };
  if (gap > dust) {
    // Free NEAR from the yield side, counting what is already on its way back.
    const need = gap - v.liquid - v.yieldUnstaking - v.aiUnstaking;
    if (need > dust && v.yieldStaked > dust) return { kind: "UnstakeYield", amount: Math.min(need, v.yieldStaked) };
  }
  if (-gap > dust) return { kind: "UnstakeAi", amount: -gap };
  const spare = v.liquid - Math.max(0, gap);
  if (spare > dust) return { kind: "StakeYield", amount: spare };
  return null;
}
