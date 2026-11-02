// The live Ballast agent. Each tick it: syncs the vault, reads both staking sides and the credit meter, runs the
// policy, and if needed sets a new AI target and steps the vault toward it. It signs with the vault's
// function-call key, which can call only rebalance / step / sync.
//
//   node src/agent.ts once                 one tick
//   node src/agent.ts loop [seconds]       tick forever (default every 600 s)
//   node src/agent.ts usage <usd>          record AI usage on the testnet credit meter (e.g. a spike)
//   node src/agent.ts status               print the plan without acting
import { call, view, near, fmt, readKey, useKey, explorer, TGAS, NEAR } from "./near.ts";
import { readDeployment } from "./config.ts";
import { plan, nextAction, creditRateFromFarm, DEFAULT_PARAMS, type Action, type Market, type VaultBooks } from "./policy.ts";
import { Meter } from "./meter.ts";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dep = readDeployment();
const V = dep.vault;

const BUDGET_USD_WEEK = Number(process.env.BUDGET_USD_WEEK ?? "0.015"); // testnet-sized: the demo vault is ~12 NEAR
const USD_PER_REWARD_UNIT = Number(process.env.USD_PER_REWARD_UNIT ?? "1");

const market: Market = {
  nearUsd: Number(process.env.NEAR_USD ?? "2.5"),
  apy: Number(process.env.APY ?? "0.045"),
  commission: Number(process.env.COMMISSION ?? "0.05"),
  creditUsdPerNearDay: creditRateFromFarm(dep.farmRewardRate, USD_PER_REWARD_UNIT),
};

const toNear = (y: string | bigint) => Number(BigInt(y)) / 1e24;
/** Whole NEAR to yocto, rounded down to 0.001 NEAR so on-chain bound checks never fail on float dust. */
const toYocto = (n: number) => (BigInt(Math.floor(n * 1000)) * NEAR) / 1000n;

export async function readAll() {
  const s: any = await view(V, "get_state");
  const pend: any = await view(dep.stakingContract, "get_account_pending_unstake", { account_id: V, validator_id: dep.aiValidator });
  const farm: any = await view(dep.stakingContract, "get_farm_position", { account_id: V, product_id: dep.productId });
  const pool: any = await view(dep.yieldPool, "get_account", { account_id: V });
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
  return { state: s, books, earnedUnits, pending: pend };
}

function params(state: any) {
  return {
    ...DEFAULT_PARAMS,
    minAiShare: state.policy.min_ai_bps / 10_000,
    maxAiShare: state.policy.max_ai_bps / 10_000,
    churnNear: Number(process.env.CHURN_NEAR ?? toNear(state.policy.min_move)),
    unlockDays: Number(process.env.UNLOCK_DAYS ?? "1"),
    burnFloorUsdDay: BUDGET_USD_WEEK / 7,
  };
}

/**
 * The agent signs as the vault, so the gas it prepays (charged up front at a pessimistic price, ~0.5 NEAR for
 * 450 Tgas) leaves the vault's balance while the call runs. Don't plan to stake that NEAR.
 */
const GAS_HEADROOM_NEAR = Number(process.env.GAS_HEADROOM_NEAR ?? "0.6");

function actionArg(a: Action) {
  switch (a.kind) {
    case "WithdrawAi":
      return "WithdrawAi";
    default:
      return { [a.kind]: { amount: toYocto(a.amount).toString() } };
  }
}

function gasFor(a: Action) {
  return a.kind.endsWith("Ai") ? 450n * TGAS : 150n * TGAS;
}

export async function tick(opts: { act: boolean } = { act: true }) {
  const meter = new Meter(V, BUDGET_USD_WEEK);
  if (opts.act) await call(V, V, "sync", {}, { gas: 100n * TGAS });
  let { state, books, earnedUnits } = await readAll();
  meter.accrueBudget();
  const creditUsd = meter.balance(earnedUnits, USD_PER_REWARD_UNIT);
  const total = toNear(state.total);
  const p = plan({ totalNear: total, aiNear: books.aiStaked, creditUsd, dailyUsageUsd: meter.dailyUsage() }, market, params(state));
  const currentTarget = toNear(state.target_ai);

  console.log(
    `[${new Date().toISOString()}] total ${total.toFixed(3)} NEAR | AI ${books.aiStaked.toFixed(3)} | yield ${books.yieldStaked.toFixed(3)} | liquid ${books.liquid.toFixed(3)} | unbonding ${(books.aiUnstaking + books.yieldUnstaking).toFixed(3)}`,
  );
  console.log(
    `  credits $${creditUsd.toFixed(6)} | burn $${p.burnUsdDay.toFixed(6)}/day | runway ${Number.isFinite(p.runwayDays) ? p.runwayDays.toFixed(2) + "d" : "∞"} | coverage ${(p.coverage * 100).toFixed(0)}%`,
  );
  console.log(`  plan: target ${p.targetAiNear.toFixed(3)} NEAR AI (raw ${p.rawTargetAiNear.toFixed(3)}), ${p.reason}`);
  if (!opts.act) return { plan: p, books };

  let target = currentTarget;
  const txs: string[] = [];
  if (p.move && Math.abs(p.targetAiNear - currentTarget) >= params(state).churnNear) {
    target = Math.floor(p.targetAiNear * 1000) / 1000;
    const a = nextAction(books, target, 1, 0.5, GAS_HEADROOM_NEAR);
    const report = {
      burn_micro_usd_per_day: String(Math.round(p.burnUsdDay * 1e6)),
      credit_balance_micro_usd: String(Math.round(creditUsd * 1e6)),
      source: meter.source,
      reason: p.reason,
    };
    const r = await call(V, V, "rebalance", { target_ai: toYocto(target).toString(), report, action: a ? actionArg(a) : null }, { gas: a ? gasFor(a) : 50n * TGAS });
    txs.push(r.txHash);
    console.log(`  → rebalance to ${target} NEAR${a ? ` + ${a.kind}` : ""}: ${explorer(r.txHash)}${r.failures.length ? " FAILED " + r.failures.join(";") : ""}`);
    ({ books } = await readAll());
  }
  // Keep stepping toward the on-chain target until there is nothing left to do this epoch.
  for (let i = 0; i < 5; i++) {
    const a = nextAction(books, target, 1, 0.5, GAS_HEADROOM_NEAR);
    if (!a) break;
    const r = await call(V, V, "step", { action: actionArg(a) }, { gas: gasFor(a) });
    txs.push(r.txHash);
    const failed = r.failures.length > 0 || r.events.some((e) => e.event === "step_failed");
    console.log(`  → ${a.kind}${"amount" in a ? " " + a.amount.toFixed(3) : ""}: ${explorer(r.txHash)}${failed ? " (did not complete; will retry next tick)" : ""}`);
    if (failed) break;
    ({ books } = await readAll());
  }
  return { plan: p, books, txs };
}

async function main() {
  const [cmd = "once", arg] = process.argv.slice(2);
  if (cmd === "usage") {
    const m = new Meter(V, BUDGET_USD_WEEK);
    m.record(Number(arg), "manual usage event");
    console.log(`recorded $${arg} of usage`);
    return;
  }
  if (cmd === "status") {
    await tick({ act: false });
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
