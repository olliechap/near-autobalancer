// The live Ballast agent. Each tick it: syncs the vault, reads both staking sides and the credit meter, runs the
// policy, buys emergency credits if runway is shorter than it takes to add stake, and if needed sets a new AI
// target and steps the vault toward it. It signs with the vault's function-call key, which can call only
// rebalance / step / sync. Every tick is appended to state/<vault>.log.jsonl, which `digest` summarises.
//
//   node src/agent.ts once                 one tick
//   node src/agent.ts loop [seconds]       tick forever (default every 600 s)
//   node src/agent.ts usage <usd>          record AI usage on the testnet credit meter (e.g. a spike)
//   node src/agent.ts status               print the plan without acting
//   node src/agent.ts digest [days]        what the agent did and what it earned, default the last 7 days
import { call, view, readKey, useKey, explorer, TGAS, NEAR } from "./near.ts";
import { readDeployment } from "./config.ts";
import {
  plan, nextAction, topupPacks, creditRateFromFarm, usd, DEFAULT_PARAMS,
  type Action, type Market, type VaultBooks, type PolicyParams,
} from "./policy.ts";
import { Meter } from "./meter.ts";
import { appendLog, digest } from "./log.ts";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dep = readDeployment();
const V = dep.vault;

/** Fallback when the vault's policy has no budget_micro_usd_week. Testnet-sized: the demo vault is ~12 NEAR. */
const ENV_BUDGET_USD_WEEK = Number(process.env.BUDGET_USD_WEEK ?? "0.015");
const USD_PER_REWARD_UNIT = Number(process.env.USD_PER_REWARD_UNIT ?? "1");

const market: Market = {
  nearUsd: Number(process.env.NEAR_USD ?? "2.5"),
  apy: Number(process.env.APY ?? "0.045"),
  commission: Number(process.env.COMMISSION ?? "0.05"),
  creditUsdPerNearDay: creditRateFromFarm(dep.farmRewardRate, USD_PER_REWARD_UNIT),
};

/**
 * The agent signs as the vault, so the gas it prepays (charged up front at a pessimistic price, ~0.5 NEAR for
 * 450 Tgas) leaves the vault's balance while the call runs. Don't plan to stake that NEAR.
 */
const GAS_HEADROOM_NEAR = Number(process.env.GAS_HEADROOM_NEAR ?? "0.6");

const toNear = (y: string | bigint) => Number(BigInt(y)) / 1e24;
/** Whole NEAR to yocto, rounded down to 0.001 NEAR so on-chain bound checks never fail on float dust. */
const toYocto = (n: number) => (BigInt(Math.floor(n * 1000)) * NEAR) / 1000n;

export function budgetUsdWeek(state: any): number {
  const b = state.policy.budget_micro_usd_week;
  return b != null ? Number(b) / 1e6 : ENV_BUDGET_USD_WEEK;
}

export async function readAll() {
  const s: any = await view(V, "get_state");
  const pend: any = await view(dep.stakingContract, "get_account_pending_unstake", { account_id: V, validator_id: dep.aiValidator });
  const farm: any = await view(dep.stakingContract, "get_farm_position", { account_id: V, product_id: dep.productId });
  const pool: any = await view(dep.yieldPool, "get_account", { account_id: V });
  const purchases: any[] = await view(dep.stakingContract, "get_purchases_for_account", { account_id: V, from_index: 0, limit: 100 });
  const books: VaultBooks = {
    liquid: toNear(s.liquid),
    aiStaked: farm ? toNear(farm.staked_near_amount) : 0,
    aiUnstaking: toNear(pend.total_pending_yocto),
    aiWithdrawable: toNear(pend.withdrawable_yocto),
    yieldStaked: toNear(pool.staked_balance),
    yieldUnstaking: toNear(pool.unstaked_balance),
    yieldCanWithdraw: pool.can_withdraw,
  };
  const earnedUnits = farm ? BigInt(farm.total_earned_reward_units) : 0n;
  // One-off packs are bought in NEAR; on testnet the meter credits them at the NEAR price.
  const purchasedNear = purchases.reduce((a, p) => a + toNear(p.amount_paid), 0);
  return { state: s, books, earnedUnits, purchasedUsd: purchasedNear * market.nearUsd };
}

function params(state: any): PolicyParams {
  return {
    ...DEFAULT_PARAMS,
    minAiShare: state.policy.min_ai_bps / 10_000,
    maxAiShare: state.policy.max_ai_bps / 10_000,
    bufferDays: state.policy.buffer_days ?? DEFAULT_PARAMS.bufferDays,
    churnNear: Number(process.env.CHURN_NEAR ?? toNear(state.policy.min_move)),
    unlockDays: Number(process.env.UNLOCK_DAYS ?? "1"),
    burnFloorUsdDay: budgetUsdWeek(state) / 7,
  };
}

function actionArg(a: Action) {
  return a.kind === "WithdrawAi" ? "WithdrawAi" : { [a.kind]: { amount: toYocto(a.amount).toString() } };
}

function gasFor(kind: string) {
  return kind.endsWith("Ai") ? 450n * TGAS : 150n * TGAS;
}

export async function tick(opts: { act: boolean } = { act: true }) {
  if (opts.act) await call(V, V, "sync", {}, { gas: 100n * TGAS });
  let { state, books, earnedUnits, purchasedUsd } = await readAll();
  const budget = budgetUsdWeek(state);
  const meter = new Meter(V, budget);
  meter.accrueBudget();
  const creditUsd = meter.balance(earnedUnits, USD_PER_REWARD_UNIT, purchasedUsd);
  const total = toNear(state.total);
  const pp = params(state);
  const obs = { totalNear: total, aiNear: books.aiStaked, creditUsd, dailyUsageUsd: meter.dailyUsage() };
  const p = plan(obs, market, pp);
  const currentTarget = toNear(state.target_ai);

  console.log(
    `[${new Date().toISOString()}] total ${total.toFixed(3)} NEAR | AI ${books.aiStaked.toFixed(3)} | yield ${books.yieldStaked.toFixed(3)} | liquid ${books.liquid.toFixed(3)} | unbonding ${(books.aiUnstaking + books.yieldUnstaking).toFixed(3)}`,
  );
  console.log(
    `  credits ${usd(creditUsd)} | burn ${usd(p.burnUsdDay)}/day (budget ${usd(budget)}/week) | runway ${Number.isFinite(p.runwayDays) ? p.runwayDays.toFixed(2) + "d" : "∞"} | coverage ${(p.coverage * 100).toFixed(0)}%${p.emergency ? " | EMERGENCY" : ""}`,
  );
  console.log(`  plan: target ${p.targetAiNear.toFixed(3)} NEAR AI (raw ${p.rawTargetAiNear.toFixed(3)}), ${p.reason}`);

  const entry: any = {
    t: Date.now(),
    totalNear: total,
    aiNear: books.aiStaked,
    yieldValueNear: books.yieldStaked + books.yieldUnstaking,
    yieldEarnedNear: toNear(state.yield_earned ?? "0"),
    creditUsd,
    spentUsd: meter.spent(),
    earnedUsd: meter.earnedUsd(earnedUnits, USD_PER_REWARD_UNIT, purchasedUsd),
    burnUsdDay: p.burnUsdDay,
    runwayDays: Number.isFinite(p.runwayDays) ? p.runwayDays : null,
    targetAiNear: currentTarget,
    actions: [] as any[],
  };
  if (!opts.act) return { plan: p, books };

  const record = (kind: string, detail: object, r: { txHash: string; failures: string[]; events: any[] }) => {
    const ok = r.failures.length === 0 && !r.events.some((e) => e.event === "step_failed");
    entry.actions.push({ kind, ...detail, tx: r.txHash, ok });
    return ok;
  };

  // 1. Emergency: credits run out before new stake could land. Buy one-off packs from earned yield.
  const packYocto = dep.topupPriceId ? BigInt((await view<any>(dep.stakingContract, "get_price", { price_id: dep.topupPriceId }))?.amount ?? 0) : 0n;
  if (p.emergency && packYocto > 0n) {
    const packs = topupPacks(p, obs, market, pp, toNear(packYocto), toNear(state.topup_available ?? "0"));
    if (packs > 0) {
      const amount = (packYocto * BigInt(packs)).toString();
      const r = await call(V, V, "step", { action: { BuyCredits: { price_id: dep.topupPriceId, quantity: String(packs), amount } } }, { gas: gasFor("BuyCredits") });
      const ok = record("BuyCredits", { packs, near: toNear(amount) }, r);
      console.log(`  → BuyCredits ${packs} pack(s), ${toNear(amount)} NEAR: ${explorer(r.txHash)}${ok ? "" : " (failed)"}`);
      ({ books } = await readAll());
    } else console.log(`  emergency, but no top-up allowed now (available ${toNear(state.topup_available ?? "0")} NEAR)`);
  }

  // 2. New target, if the plan moved far enough.
  let target = currentTarget;
  // The vault checks the share against its total *during* the call, which is short by the prepaid gas.
  const onChainMax = pp.maxAiShare * Math.max(0, total - GAS_HEADROOM_NEAR);
  const wanted = Math.floor(Math.min(p.targetAiNear, onChainMax) * 1000) / 1000;
  if (p.move && Math.abs(wanted - currentTarget) >= pp.churnNear) {
    target = wanted;
    const a = nextAction(books, target, 1, 0.5, GAS_HEADROOM_NEAR);
    const report = {
      burn_micro_usd_per_day: String(Math.round(p.burnUsdDay * 1e6)),
      credit_balance_micro_usd: String(Math.round(creditUsd * 1e6)),
      source: meter.source,
      reason: p.reason,
    };
    const r = await call(V, V, "rebalance", { target_ai: toYocto(target).toString(), report, action: a ? actionArg(a) : null }, { gas: a ? gasFor(a.kind) : 50n * TGAS });
    const ok = record("rebalance", { fromNear: currentTarget, toNear: target, reason: p.reason, step: a?.kind, amount: a && "amount" in a ? a.amount : undefined }, r);
    console.log(`  → rebalance to ${target} NEAR${a ? ` + ${a.kind}` : ""}: ${explorer(r.txHash)}${ok ? "" : " FAILED " + r.failures.join(";")}`);
    if (ok) entry.targetAiNear = target;
    else target = currentTarget;
    ({ books } = await readAll());
  }

  // 3. Keep stepping toward the on-chain target until there is nothing left to do this epoch.
  for (let i = 0; i < 5; i++) {
    const a = nextAction(books, target, 1, 0.5, GAS_HEADROOM_NEAR);
    if (!a) break;
    const r = await call(V, V, "step", { action: actionArg(a) }, { gas: gasFor(a.kind) });
    const ok = record(a.kind, { amount: "amount" in a ? a.amount : undefined }, r);
    console.log(`  → ${a.kind}${"amount" in a ? " " + a.amount.toFixed(3) : ""}: ${explorer(r.txHash)}${ok ? "" : " (did not complete; will retry next tick)"}`);
    if (!ok) break;
    ({ books } = await readAll());
  }
  appendLog(V, entry);
  return { plan: p, books };
}

async function main() {
  const [cmd = "once", arg] = process.argv.slice(2);
  if (cmd === "usage") {
    const m = new Meter(V, budgetUsdWeek(await view(V, "get_state")));
    m.record(Number(arg), "manual usage event");
    console.log(`recorded $${arg} of usage`);
    return;
  }
  if (cmd === "status") {
    await tick({ act: false });
    return;
  }
  if (cmd === "digest") {
    console.log(digest(V, Number(arg ?? "7"), market.nearUsd));
    return;
  }
  const kp = readKey(`${V}.agent`);
  if (!kp) throw new Error(`no agent key for ${V}: run scripts/deploy-testnet.ts first`);
  await useKey(V, kp);
  if (cmd === "once") await tick();
  else if (cmd === "loop") {
    const every = Number(arg ?? "600") * 1000;
    for (;;) {
      try {
        await tick();
      } catch (e) {
        console.error("tick failed:", e);
      }
      await new Promise((r) => setTimeout(r, every));
    }
  } else throw new Error(`unknown command ${cmd}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch((e) => { console.error(e); process.exit(1); });
