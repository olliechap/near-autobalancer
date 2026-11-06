// Mainnet proof: a Ballast vault on its own .near account stakes into NEAR AI's real farm (stake.dao).
//
//   NEAR_NETWORK=mainnet OWNER=<funded account> node scripts/mainnet-proof.ts setup   create + deploy + stake
//   NEAR_NETWORK=mainnet OWNER=<funded account> node scripts/mainnet-proof.ts status  farm position and credits
//
// Writes agent/deployments/mainnet.json. Keys are read from / written to ~/.near-credentials-ballast.
import fs from "node:fs";
import path from "node:path";
import { KeyPair } from "near-api-js";
import { account, accountExists, call, view, near, fmt, saveKey, useKey, explorer, TGAS, NETWORK } from "../src/near.ts";

if (NETWORK !== "mainnet") throw new Error("set NEAR_NETWORK=mainnet");
const OWNER = process.env.OWNER!;
if (!OWNER) throw new Error("set OWNER to the funded mainnet account");

const STAKING = "stake.dao";
const PRODUCT = "prod_33Kp14MGUJa2QA"; // "NEAR AI Cloud Credits", Farm price "100 $NEAR x 1 month = $1 credit"
const VALIDATOR = "nearai.pool.near";
const YIELD_POOL = process.env.YIELD_POOL ?? "astro-stakers.poolv1.near"; // unused in the proof
const STAKE_NEAR = process.env.STAKE_NEAR ?? "1.5";
const DEP = path.resolve(import.meta.dirname, "../deployments/mainnet.json");
const WASM = path.resolve(import.meta.dirname, "../../target/wasm32-unknown-unknown/release/ballast_vault.wasm");

function log(label: string, r: any) {
  const bad = r.failures.length || r.events.some((e: any) => e.event === "step_failed");
  console.log(`${bad ? "✗" : "✓"} ${label}: ${explorer(r.txHash)}${bad ? " " + (r.failures[0] ?? "step_failed").slice(0, 300) : ""}`);
  return !bad;
}

async function status(V: string) {
  const s: any = await view(V, "get_state");
  const farm: any = await view(STAKING, "get_farm_position", { account_id: V, product_id: PRODUCT });
  console.log(`vault ${V}: liquid ${fmt(s.liquid)} | AI target ${fmt(s.target_ai)} | AI staked ${fmt(s.ai_staked)}`);
  if (farm) {
    const units = BigInt(farm.total_earned_reward_units ?? "0");
    console.log(`farm position: staked ${fmt(farm.staked_near_amount)} NEAR | earned ${Number(units) / 1e24} reward units ($1 each)`);
  } else console.log("farm position: none");
}

const cmd = process.argv[2];
if (cmd === "setup") {
  let dep: any = fs.existsSync(DEP) ? JSON.parse(fs.readFileSync(DEP, "utf8")) : null;
  const V: string = dep?.vault ?? `ballast-vault-${Date.now().toString(36)}.near`;
  if (!(await accountExists(V))) {
    const kp = KeyPair.fromRandom("ed25519");
    saveKey(V, V, kp);
    fs.writeFileSync(DEP, JSON.stringify({ network: "mainnet", owner: OWNER, vault: V, stakingContract: STAKING, productId: PRODUCT, aiValidator: VALIDATOR, yieldPool: YIELD_POOL }, null, 2) + "\n");
    const fund = process.env.VAULT_FUND_NEAR ?? "4.85";
    log(`create ${V} with ${fund} NEAR`, await call(OWNER, "near", "create_account", { new_account_id: V, new_public_key: kp.getPublicKey().toString() }, { deposit: near(fund), gas: 100n * TGAS }));
    await useKey(V, kp);
    const acc = await account(V);
    const d = await acc.deployContract(fs.readFileSync(WASM));
    console.log(`✓ deploy vault code: ${explorer(d.transaction.hash)}`);
    log("init", await call(V, V, "new", {
      owner_id: OWNER, staking_contract: STAKING, ai_product_id: PRODUCT, ai_validator_id: VALIDATOR, yield_pool: YIELD_POOL,
      policy: { min_ai_bps: 0, max_ai_bps: 9000, buffer_days: 3, cooldown_sec: "0", min_move: "0", topup_cap: "0" },
    }, { gas: 100n * TGAS }));
  }
  // The default 1 NEAR reserve is sized for real vaults; 0.5 NEAR (the minimum) leaves more of 5 NEAR to stake.
  log("reserve 0.5 NEAR", await call(OWNER, V, "set_reserve", { reserve: near("0.5").toString() }, { deposit: 1n }));
  if (!(await view(STAKING, "storage_balance_of", { account_id: V })))
    log("register with stake.dao", await call(OWNER, V, "register_ai", { amount: near("0.02").toString() }, { deposit: 1n, gas: 100n * TGAS }));
  await call(OWNER, V, "set_agent", { agent_id: OWNER }, { deposit: 1n });
  if ((await view<any>(V, "get_state")).ai_staked === "0") {
    const amt = near(STAKE_NEAR).toString();
    const report = { burn_micro_usd_per_day: "0", credit_balance_micro_usd: "0", source: "mainnet-proof", reason: "mainnet proof" };
    log(`target ${STAKE_NEAR} NEAR AI + StakeAi into NEAR AI's farm`, await call(OWNER, V, "rebalance", { target_ai: amt, report, action: { StakeAi: { amount: amt } } }, { gas: 450n * TGAS }));
  }
  await call(OWNER, V, "sync", {}, { gas: 100n * TGAS });
  await status(V);
} else if (cmd === "status") {
  await status(JSON.parse(fs.readFileSync(DEP, "utf8")).vault);
} else console.log("usage: mainnet-proof.ts setup|status");
