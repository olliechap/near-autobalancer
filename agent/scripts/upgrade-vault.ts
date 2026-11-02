// Upgrade a deployed vault's code and migrate its state in one transaction (deploy + `migrate`), then set up the
// emergency top-up: a one-off "credits" price on the AI product, and a policy with a top-up cap and the budget.
//
//   node scripts/upgrade-vault.ts [vault-account]        default: the vault in deployments/testnet.json
import fs from "node:fs";
import path from "node:path";
import { transactions } from "near-api-js";
import { account, call, view, near, fmt, TGAS, NEAR } from "../src/near.ts";
import { readDeployment, writeDeployment } from "../src/config.ts";

const dep = readDeployment();
const V = process.argv[2] ?? dep.vault;
const WASM = path.resolve(import.meta.dirname, "../../target/wasm32-unknown-unknown/release/ballast_vault.wasm");
/**
 * One-off top-up price on testnet: 0.001 NEAR per pack, which the meter credits at NEAR_USD per NEAR ($0.0025),
 * about one day of the testnet budget. Sized to the testnet vault; on mainnet NEAR AI sells credits itself.
 */
const TOPUP_PRICE = near("0.001");

const target = /^version = "(.+)"/m.exec(fs.readFileSync(path.resolve(import.meta.dirname, "../../contracts/vault/Cargo.toml"), "utf8"))![1];
const version: string = await view(V, "get_version").catch(() => "0.1.0");
console.log(`${V}: running ${version}, repo has ${target}`);
if (version !== target) {
  // Only a v1 vault needs `migrate`; v2.x releases keep the v2 state layout, and running migrate on it would fail.
  const actions = [transactions.deployContract(fs.readFileSync(WASM))];
  if (version.startsWith("0.1")) actions.push(transactions.functionCall("migrate", {}, 100n * TGAS, 0n));
  const acc = await account(V);
  const r: any = await acc.signAndSendTransaction({ receiverId: V, actions });
  const failed = r.receipts_outcome.find((x: any) => x.outcome.status.Failure);
  if (failed) throw new Error("upgrade failed: " + JSON.stringify(failed.outcome.status.Failure));
  console.log(`upgraded to ${await view(V, "get_version")}${actions.length > 1 ? " with migrate" : ""}: tx ${r.transaction.hash}`);
}

// One-off price for top-ups on the AI product.
let topupPriceId = (dep as any).topupPriceId as string | undefined;
if (topupPriceId) {
  const p: any = await view(dep.stakingContract, "get_price", { price_id: topupPriceId });
  if (!p || p.amount !== TOPUP_PRICE.toString() || p.status !== "Active") {
    if (p?.status === "Active")
      await call(dep.root, dep.stakingContract, "archive_price", { price_id: topupPriceId }, { deposit: 1n, gas: 100n * TGAS });
    topupPriceId = undefined;
  }
}
if (!topupPriceId) {
  const r = await call(dep.root, dep.stakingContract, "create_price", {
    product_id: dep.productId,
    name: "One-off credits",
    description: "Emergency credit pack: 0.001 NEAR",
    amount: TOPUP_PRICE.toString(),
    price_type: "OneOff",
    billing_period: null,
    lock_factor_near_months: "0",
    metadata: null,
  }, { deposit: 1n, gas: 100n * TGAS });
  if (r.failures.length) throw new Error("create_price failed: " + r.failures.join("; "));
  const prices = r.events.filter((e: any) => e.event === "price_create").map((e: any) => e.data.price_id);
  topupPriceId = r.value?.price_id ?? (typeof r.value === "string" ? r.value : prices[0]);
  writeDeployment({ ...dep, topupPriceId } as any);
  console.log(`one-off price ${topupPriceId} created`);
}

const s: any = await view(V, "get_state");
if (V === dep.vault && s.policy.budget_micro_usd_week == null) {
  const policy = { ...s.policy, topup_cap: near("0.5").toString(), budget_micro_usd_week: "15000" }; // $0.015/week
  const r = await call(dep.root, V, "set_policy", { policy }, { deposit: 1n });
  console.log(`policy set (top-up cap 0.5 NEAR / 30 days, budget $0.015/week): ${r.txHash}${r.failures.length ? " FAILED" : ""}`);
}
const after: any = await view(V, "get_state");
console.log(JSON.stringify({ policy: after.policy, yield_earned: fmt(after.yield_earned), topup_available: fmt(after.topup_available), ai: fmt(after.ai_staked), yield: fmt(after.yield_staked) }, null, 1));
