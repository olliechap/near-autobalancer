// Shows the security story on testnet: what the agent key and strangers cannot do.
//   1. The agent's function-call key tries to call `withdraw` on the vault: rejected by the protocol.
//   2. The agent key tries to set an AI target above the owner's max share: rejected by the vault.
//   3. A stranger tries to move funds with `step`: rejected by the vault.
import { KeyPair } from "near-api-js";
import { call, readKey, useKey, near, TGAS, CREDENTIALS_DIR } from "../src/near.ts";
import { readDeployment } from "../src/config.ts";
import fs from "node:fs";

const dep = readDeployment();
const V = dep.vault;
const report = { burn_micro_usd_per_day: "0", credit_balance_micro_usd: "0", source: "trust-demo", reason: "attack" };

async function attempt(label: string, f: () => Promise<any>) {
  try {
    const r = await f();
    if (r.failures?.length) console.log(`✗ ${label}: rejected on-chain: ${r.failures[0].slice(0, 200)}`);
    else console.log(`!! ${label}: SUCCEEDED (unexpected) ${r.txHash}`);
  } catch (e: any) {
    console.log(`✗ ${label}: rejected: ${String(e.type ?? "")} ${String(e.message ?? e).slice(0, 200)}`);
  }
}

const agentKey = readKey(`${V}.agent`)!;
await useKey(V, agentKey);
await attempt("agent key calls withdraw", () => call(V, V, "withdraw", { amount: near("1").toString() }, { gas: 30n * TGAS }));
await attempt("agent key sets AI target to 99% of the vault", () =>
  call(V, V, "rebalance", { target_ai: near("11.9").toString(), report, action: null }, { gas: 30n * TGAS }));

const stranger = fs.readdirSync(CREDENTIALS_DIR).find((f) => f.startsWith("ballast-fund"))?.replace(/\.json$/, "");
if (stranger)
  await attempt(`stranger ${stranger} calls step`, () =>
    call(stranger, V, "step", { action: { UnstakeYield: { amount: near("1").toString() } } }, { gas: 20n * TGAS }));
