// Deploys the whole Ballast testnet stack under one root account. Safe to re-run: each step is skipped if done.
//
//   pool-ai.<root>     Ballast pool, the validator behind the staking contract (AI side)
//   stake.<root>       NEAR AI's staking-contract (house-of-stake, pinned release build) with a Farm product
//   pool-yield.<root>  Ballast pool with 4.5% APY and a 1-epoch unbond (yield side)
//   vault.<root>       Ballast vault owned by <root>, with a function-call agent key
//
// Usage: BALLAST_ROOT=<root>.testnet node scripts/deploy-testnet.ts
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { KeyPair } from "near-api-js";
import {
  account, accountExists, call, view, near, fmt, saveKey, readKey, NEAR, TGAS, CREDENTIALS_DIR,
} from "../src/near.ts";
import { writeDeployment, type Deployment } from "../src/config.ts";

const ROOT = process.env.BALLAST_ROOT;
if (!ROOT) throw new Error("set BALLAST_ROOT to a funded testnet account whose key is in " + CREDENTIALS_DIR);

const REPO = path.resolve(import.meta.dirname, "../..");
const WASM_DIR = path.join(REPO, "target/wasm32-unknown-unknown/release");
const HOS_COMMIT = "056fb6e61ae9cbad1480fc5a8cc3138afa50c97b";
const HOS_URL = `https://raw.githubusercontent.com/nearai/house-of-stake-contracts/${HOS_COMMIT}/res/release/staking_contract.wasm`;
const HOS_SHA256 = "d4d875001b8f492a6ec09c1d2f7f021471fd317e0c3462c563b737099ec143e9";
/** NEAR AI's own testnet farm rate: "$100 NEAR x 1 month = $1 credit" (house-of-stake cli/config/dev.testnet.json). */
const FARM_REWARD_RATE = "3802570537683474";
const VAULT_DEPOSIT = near(process.env.VAULT_DEPOSIT ?? "12");

const ids = {
  poolAi: `pool-ai.${ROOT}`,
  poolYield: `pool-yield.${ROOT}`,
  stake: `stake.${ROOT}`,
  vault: `vault.${ROOT}`,
};

async function sweepFunders() {
  // Faucet accounts named ballast-fund*.testnet are swept into the root so it can pay for storage.
  if (!fs.existsSync(CREDENTIALS_DIR)) return;
  for (const f of fs.readdirSync(CREDENTIALS_DIR)) {
    if (!f.startsWith("ballast-fund")) continue;
    const id = f.replace(/\.json$/, "");
    const acc = await account(id);
    const bal = BigInt((await acc.getAccountBalance()).available);
    if (bal < near("1")) continue;
    const amt = bal - near("0.05");
    await acc.sendMoney(ROOT!, amt);
    console.log(`swept ${fmt(amt)} NEAR from ${id}`);
  }
}

async function ensureAccount(id: string, amount: bigint) {
  if (await accountExists(id)) return false;
  const kp = KeyPair.fromRandom("ed25519");
  saveKey(id, id, kp);
  const root = await account(ROOT!);
  await root.createAccount(id, kp.getPublicKey(), amount);
  // Reload the key store entry for the new account.
  const { useKey } = await import("../src/near.ts");
  await useKey(id, kp);
  console.log(`created ${id} with ${fmt(amount)} NEAR`);
  return true;
}

async function isDeployed(id: string) {
  const s: any = await (await account(id)).state();
  return s.code_hash !== "11111111111111111111111111111111";
}

async function deploy(id: string, wasm: Buffer, init: { method: string; args: object }) {
  if (await isDeployed(id)) {
    console.log(`${id}: already deployed`);
    return;
  }
  const acc = await account(id);
  await acc.deployContract(wasm);
  await acc.functionCall({ contractId: id, methodName: init.method, args: init.args, gas: 100n * TGAS });
  console.log(`${id}: deployed and initialised`);
}

async function hosWasm(): Promise<Buffer> {
  const cache = path.join(REPO, "target", "staking_contract.wasm");
  let buf: Buffer;
  if (fs.existsSync(cache)) buf = fs.readFileSync(cache);
  else {
    const r = await fetch(HOS_URL);
    if (!r.ok) throw new Error(`fetching staking_contract.wasm: HTTP ${r.status}`);
    buf = Buffer.from(await r.arrayBuffer());
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, buf);
  }
  const sha = crypto.createHash("sha256").update(buf).digest("hex");
  if (sha !== HOS_SHA256) throw new Error(`staking_contract.wasm sha256 mismatch: ${sha}`);
  return buf;
}

function ourWasm(name: string): Buffer {
  const p = path.join(WASM_DIR, `${name}.wasm`);
  if (!fs.existsSync(p)) throw new Error(`${p} missing: run ./scripts/build.sh first`);
  return fs.readFileSync(p);
}

async function main() {
  await sweepFunders();
  const rootBal = BigInt((await (await account(ROOT!)).getAccountBalance()).available);
  console.log(`root ${ROOT}: ${fmt(rootBal)} NEAR available`);

  // 1. AI-side pool: no APY (NEAR AI's validator keeps the rewards), no unbond delay at the pool itself.
  await ensureAccount(ids.poolAi, near("2.5"));
  await deploy(ids.poolAi, ourWasm("ballast_pool"), { method: "new", args: { owner_id: ROOT, unlock_epochs: 0, apy_bps: 0 } });

  // 2. Yield-side pool: 4.5% APY, 1-epoch unbond on testnet (mainnet pools use 4).
  await ensureAccount(ids.poolYield, near("3"));
  await deploy(ids.poolYield, ourWasm("ballast_pool"), { method: "new", args: { owner_id: ROOT, unlock_epochs: 1, apy_bps: 450 } });

  // 3. NEAR AI staking contract.
  await ensureAccount(ids.stake, near("9"));
  await deploy(ids.stake, await hosWasm(), {
    method: "new",
    args: {
      config: {
        owner_account_id: ROOT,
        proposed_new_owner_account_id: null,
        guardians: [],
        min_lock_duration_ns: "1",
        max_lock_duration_ns: "63072000000000000",
        epoch_unstake_settle_epochs: 0,
        min_storage_deposit: "10000000000000000000000",
        per_lock_storage_stake: "10000000000000000000000",
        per_farm_position_storage_stake: "5000000000000000000000",
        per_purchase_storage_stake: "5000000000000000000000",
        min_lock_amount: NEAR.toString(),
      },
    },
  });
  if (!(await view(ids.stake, "get_validator", { validator_id: ids.poolAi }))) {
    await call(ROOT!, ids.stake, "add_validator", { validator_id: ids.poolAi }, { deposit: 1n });
    console.log(`validator ${ids.poolAi} added`);
  }
  let products: any[] = await view(ids.stake, "get_products", { from_index: 0, limit: 10 });
  if (products.length === 0) {
    const r = await call(ROOT!, ids.stake, "create_product", {
      validator_id: ids.poolAi,
      name: "NEAR AI Cloud Credits (Ballast testnet)",
      description: "Stake for inference: staking rewards become NEAR AI credits",
    }, { deposit: 1n, gas: 100n * TGAS });
    if (r.failures.length) throw new Error("create_product failed: " + r.failures.join("; "));
    products = await view(ids.stake, "get_products", { from_index: 0, limit: 10 });
  }
  const product = products[0];
  let priceId: string | null = product.default_price_id ?? null;
  if (!priceId) {
    const r = await call(ROOT!, ids.stake, "create_price", {
      product_id: product.product_id,
      name: "Staking Farm",
      description: "$100 NEAR x 1 month = $1 credit",
      amount: NEAR.toString(),
      price_type: "Farm",
      billing_period: null,
      lock_factor_near_months: "0",
      metadata: { max_amount: null, farm_reward_rate: FARM_REWARD_RATE },
    }, { deposit: 1n, gas: 100n * TGAS });
    if (r.failures.length) throw new Error("create_price failed: " + r.failures.join("; "));
    priceId = r.value?.price_id ?? r.value;
    await call(ROOT!, ids.stake, "set_product_default_price", { product_id: product.product_id, price_id: priceId }, { deposit: 1n, gas: 100n * TGAS });
    console.log(`farm price ${priceId} created and set as default`);
  }

  // 4. Vault.
  const createdVault = await ensureAccount(ids.vault, near("3"));
  await deploy(ids.vault, ourWasm("ballast_vault"), {
    method: "new",
    args: {
      owner_id: ROOT,
      staking_contract: ids.stake,
      ai_product_id: product.product_id,
      ai_validator_id: ids.poolAi,
      yield_pool: ids.poolYield,
      policy: {
        min_ai_bps: 0,
        max_ai_bps: 9000,
        buffer_days: 7,
        cooldown_sec: "60",
        min_move: near("0.5").toString(),
        topup_cap: "0",
      },
    },
  });
  if (createdVault) {
    await call(ROOT!, ids.vault, "deposit", {}, { deposit: VAULT_DEPOSIT });
    console.log(`deposited ${fmt(VAULT_DEPOSIT)} NEAR into the vault`);
  }
  if (!(await view(ids.stake, "storage_balance_of", { account_id: ids.vault }))) {
    const r = await call(ROOT!, ids.vault, "register_ai", { amount: near("0.05").toString() }, { deposit: 1n });
    if (r.failures.length) throw new Error("register_ai failed: " + r.failures.join("; "));
    console.log("vault registered with the staking contract");
  }

  // Agent key: a function-call key on the vault account limited to rebalance/step/sync.
  if (!readKey(`${ids.vault}.agent`)) {
    const kp = KeyPair.fromRandom("ed25519");
    const vaultAcc = await account(ids.vault);
    await vaultAcc.addKey(kp.getPublicKey(), ids.vault, ["rebalance", "step", "sync"], near("1"));
    saveKey(`${ids.vault}.agent`, ids.vault, kp, "agent");
    console.log(`agent key ${kp.getPublicKey().toString()} added (methods: rebalance, step, sync)`);
  }

  const dep: Deployment = {
    network: "testnet",
    root: ROOT!,
    stakingContract: ids.stake,
    aiValidator: ids.poolAi,
    yieldPool: ids.poolYield,
    vault: ids.vault,
    productId: product.product_id,
    priceId: priceId!,
    farmRewardRate: FARM_REWARD_RATE,
  };
  writeDeployment(dep);
  console.log(JSON.stringify(dep, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
