// Thin wrapper over near-api-js: a connection, an account, and typed helpers for the calls Ballast makes.
import { connect, keyStores, KeyPair, utils } from "near-api-js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export const NETWORK = process.env.NEAR_NETWORK ?? "testnet";
export const RPC = process.env.NEAR_RPC ?? (NETWORK === "mainnet" ? "https://rpc.mainnet.fastnear.com" : "https://test.rpc.fastnear.com");
/** Keys live as `<account>.json` files ({account_id, public_key, private_key}), like near-cli's credentials. */
export const CREDENTIALS_DIR =
  process.env.BALLAST_CREDENTIALS ?? path.join(os.homedir(), ".near-credentials-ballast");

export const NEAR = 10n ** 24n;
export const TGAS = 10n ** 12n;
export const ONE_YOCTO = 1n;

export function near(n: number | string): bigint {
  return BigInt(utils.format.parseNearAmount(String(n))!);
}

export function fmt(yocto: bigint | string, digits = 3): string {
  const v = BigInt(yocto);
  const sign = v < 0n ? "-" : "";
  const a = v < 0n ? -v : v;
  const whole = a / NEAR;
  const frac = (a % NEAR).toString().padStart(24, "0").slice(0, digits);
  return `${sign}${whole}.${frac}`;
}

const keyStore = new keyStores.InMemoryKeyStore();

function loadKeys(): void {
  if (!fs.existsSync(CREDENTIALS_DIR)) return;
  for (const f of fs.readdirSync(CREDENTIALS_DIR)) {
    if (!f.endsWith(".json")) continue;
    const c = JSON.parse(fs.readFileSync(path.join(CREDENTIALS_DIR, f), "utf8"));
    if (c.role === "agent") continue; // agent keys are loaded explicitly with useKey()
    // A file may hold the account's full-access key, or a named key such as `vault.x.testnet.agent.json`.
    const accountId = c.account_id ?? f.replace(/\.json$/, "");
    keyStore.setKey(NETWORK, accountId, KeyPair.fromString(c.private_key));
  }
}
loadKeys();

export function saveKey(fileStem: string, accountId: string, kp: KeyPair, role?: string): void {
  fs.mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(CREDENTIALS_DIR, `${fileStem}.json`),
    JSON.stringify({ account_id: accountId, role, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }),
    { mode: 0o600 },
  );
}

/** Use a specific key for an account (for example the vault's function-call agent key). */
export async function useKey(accountId: string, kp: KeyPair): Promise<void> {
  await keyStore.setKey(NETWORK, accountId, kp);
}

export function readKey(fileStem: string): KeyPair | undefined {
  const p = path.join(CREDENTIALS_DIR, `${fileStem}.json`);
  if (!fs.existsSync(p)) return undefined;
  return KeyPair.fromString(JSON.parse(fs.readFileSync(p, "utf8")).private_key);
}

let nearConn: Awaited<ReturnType<typeof connect>> | undefined;
export async function getNear() {
  nearConn ??= await connect({ networkId: NETWORK, nodeUrl: RPC, keyStore });
  return nearConn;
}

export async function account(id: string) {
  return (await getNear()).account(id);
}

export async function view<T = any>(contractId: string, methodName: string, args: object = {}): Promise<T> {
  const provider = (await getNear()).connection.provider;
  const res: any = await provider.query({
    request_type: "call_function",
    finality: "optimistic",
    account_id: contractId,
    method_name: methodName,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  return JSON.parse(Buffer.from(res.result).toString());
}

export async function accountExists(id: string): Promise<boolean> {
  try {
    await (await account(id)).state();
    return true;
  } catch {
    return false;
  }
}

export async function epochHeight(): Promise<number> {
  const provider = (await getNear()).connection.provider;
  const v: any = await provider.validators(null);
  return Number(v.epoch_height);
}

export interface CallResult {
  txHash: string;
  logs: string[];
  events: any[];
  value: any;
  failures: string[];
}

/** Call a change method and collect logs, NEP-297 events and any receipt failures from the whole tree. */
export async function call(
  signerId: string,
  contractId: string,
  methodName: string,
  args: object = {},
  opts: { gas?: bigint; deposit?: bigint } = {},
): Promise<CallResult> {
  const acc = await account(signerId);
  try {
    const outcome: any = await acc.functionCall({
      contractId,
      methodName,
      args,
      gas: opts.gas ?? 100n * TGAS,
      attachedDeposit: opts.deposit ?? 0n,
    });
    return summarize(outcome);
  } catch (e: any) {
    // near-api-js throws when the first receipt fails; report it the same way as a failed downstream receipt.
    if (!e?.transaction_outcome && !e?.context?.transactionHash) throw e;
    const txHash = e.transaction_outcome?.id ?? e.context.transactionHash;
    return { txHash, logs: [], events: [], value: undefined, failures: [String(e.message ?? e)] };
  }
}

export function summarize(outcome: any): CallResult {
  const logs: string[] = [];
  const failures: string[] = [];
  for (const r of [outcome.transaction_outcome, ...outcome.receipts_outcome]) {
    logs.push(...r.outcome.logs);
    const f = r.outcome.status?.Failure;
    if (f) failures.push(JSON.stringify(f));
  }
  const events = logs
    .filter((l) => l.startsWith("EVENT_JSON:"))
    .map((l) => JSON.parse(l.slice("EVENT_JSON:".length)));
  let value: any = undefined;
  const sv = outcome.status?.SuccessValue;
  if (sv) {
    try {
      value = JSON.parse(Buffer.from(sv, "base64").toString());
    } catch {
      value = Buffer.from(sv, "base64").toString();
    }
  }
  return { txHash: outcome.transaction.hash, logs, events, value, failures };
}

export function explorer(txHash: string): string {
  return NETWORK === "mainnet"
    ? `https://nearblocks.io/txns/${txHash}`
    : `https://testnet.nearblocks.io/txns/${txHash}`;
}
