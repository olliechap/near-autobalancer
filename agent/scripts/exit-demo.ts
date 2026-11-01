// Exit test on a second, small vault, so the main demo vault keeps running.
//
//   node scripts/exit-demo.ts setup    create vault-exit.<root>, deposit 3 NEAR, stake 1.5 to AI and the rest to yield
//   node scripts/exit-demo.ts exit     owner calls exit; a stranger (not owner, not agent) unwinds both sides
//   node scripts/exit-demo.ts finish   after the unbond: anyone withdraws both sides; the owner withdraws to self
import fs from "node:fs";
import path from "node:path";
import { KeyPair } from "near-api-js";
import { account, accountExists, call, view, near, fmt, saveKey, useKey, explorer, TGAS, CREDENTIALS_DIR } from "../src/near.ts";
import { readDeployment } from "../src/config.ts";

const dep = readDeployment();
const ROOT = dep.root;
const V = `vault-exit.${ROOT}`;
const WASM = path.resolve(import.meta.dirname, "../../target/wasm32-unknown-unknown/release/ballast_vault.wasm");
const stranger = fs.readdirSync(CREDENTIALS_DIR).find((f) => f.startsWith("ballast-fund"))!.replace(/\.json$/, "");

async function show(label: string) {
  await call(ROOT, V, "sync", {}, { gas: 100n * TGAS });
  const s: any = await view(V, "get_state");
  console.log(
    `${label}: liquid ${fmt(s.liquid)} | AI ${fmt(s.ai_staked)} (+${fmt(s.ai_unstaking)} unstaking, ${fmt(s.ai_withdrawable)} withdrawable) | yield ${fmt(s.yield_staked)} (+${fmt(s.yield_unstaking)} unstaking, can_withdraw ${s.yield_can_withdraw}) | exiting ${s.exiting}`,
  );
  return s;
}

function log(label: string, r: any) {
  const bad = r.failures.length || r.events.some((e: any) => e.event === "step_failed");
  console.log(`${bad ? "✗" : "✓"} ${label}: ${explorer(r.txHash)}${bad ? " " + (r.failures[0] ?? "step_failed").slice(0, 200) : ""}`);
}

const cmd = process.argv[2];
if (cmd === "setup") {
  if (!(await accountExists(V))) {
    const kp = KeyPair.fromRandom("ed25519");
    saveKey(V, V, kp);
    await (await account(ROOT)).createAccount(V, kp.getPublicKey(), near("2.3"));
    await useKey(V, kp);
    const acc = await account(V);
    await acc.deployContract(fs.readFileSync(WASM));
    await acc.functionCall({
      contractId: V,
      methodName: "new",
      args: {
        owner_id: ROOT,
        staking_contract: dep.stakingContract,
        ai_product_id: dep.productId,
        ai_validator_id: dep.aiValidator,
        yield_pool: dep.yieldPool,
        policy: { min_ai_bps: 0, max_ai_bps: 9000, buffer_days: 3, cooldown_sec: "0", min_move: "0", topup_cap: "0" },
      },
      gas: 100n * TGAS,
    });
    log("deposit 3 NEAR", await call(ROOT, V, "deposit", {}, { deposit: near("3") }));
    log("register with staking contract", await call(ROOT, V, "register_ai", { amount: near("0.05").toString() }, { deposit: 1n }));
  }
  // The owner can step too (agent or owner), which keeps this test free of a second agent key.
  const report = { burn_micro_usd_per_day: "0", credit_balance_micro_usd: "0", source: "exit-demo", reason: "setup" };
  if ((await view(V, "get_state") as any).exiting) await call(ROOT, V, "cancel_exit", {}, { deposit: 1n });
  if (BigInt((await (await account(stranger)).getAccountBalance()).available) < near("0.8"))
    await (await account(ROOT)).sendMoney(stranger, near("1")); // prepaid gas is charged up front at a pessimistic price
  await call(ROOT, V, "set_agent", { agent_id: ROOT }, { deposit: 1n });
  if ((await view(V, "get_state") as any).ai_staked === "0") log("target 1.5 NEAR AI + StakeAi", await call(ROOT, V, "rebalance", { target_ai: near("1.5").toString(), report, action: { StakeAi: { amount: near("1.5").toString() } } }, { gas: 450n * TGAS }));
  log("StakeYield 0.5", await call(ROOT, V, "step", { action: { StakeYield: { amount: near("0.5").toString() } } }, { gas: 150n * TGAS }));
  await show("after setup");
} else if (cmd === "exit") {
  log("owner exit", await call(ROOT, V, "exit", {}, { deposit: 1n }));
  const s: any = await show("after exit");
  log(`stranger ${stranger} UnstakeAi`, await call(stranger, V, "step", { action: { UnstakeAi: { amount: s.ai_staked } } }, { gas: 450n * TGAS }));
  const s2: any = await view(V, "get_state");
  log(`stranger UnstakeYield`, await call(stranger, V, "step", { action: { UnstakeYield: { amount: s2.yield_staked } } }, { gas: 150n * TGAS }));
  await show("after unwind");
} else if (cmd === "finish") {
  let s: any = await show("before finish");
  if (BigInt(s.ai_unstaking) > 0n) log("WithdrawAi", await call(stranger, V, "step", { action: "WithdrawAi" }, { gas: 450n * TGAS }));
  s = await show("after WithdrawAi");
  if (BigInt(s.ai_unstaking) > 0n) log("WithdrawAi (second pass)", await call(stranger, V, "step", { action: "WithdrawAi" }, { gas: 450n * TGAS }));
  s = await view(V, "get_state");
  if (BigInt(s.yield_unstaking) > 0n && s.yield_can_withdraw)
    log("WithdrawYield", await call(stranger, V, "step", { action: { WithdrawYield: { amount: s.yield_unstaking } } }, { gas: 150n * TGAS }));
  s = await show("after withdrawals");
  const before = BigInt((await (await account(ROOT)).getAccountBalance()).available);
  log("owner withdraws liquid", await call(ROOT, V, "withdraw", { amount: null }, { deposit: 1n }));
  const after = BigInt((await (await account(ROOT)).getAccountBalance()).available);
  console.log(`owner balance +${fmt(after - before)} NEAR`);
  await show("final");
} else console.log("usage: exit-demo.ts setup|exit|finish");
