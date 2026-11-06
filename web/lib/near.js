// Read-only NEAR RPC helpers for the dashboard. No keys, no wallet: just `call_function` views.
export const TESTNET = {
  id: "testnet",
  rpc: "https://rpc.testnet.near.org",
  explorer: "https://testnet.nearblocks.io",
  // agent/deployments/testnet.json: NEAR AI's farm product rate ($100 NEAR x 1 month = $1 credit)
  farmRewardRate: "3802570537683474",
};
export const MAINNET = {
  id: "mainnet",
  rpc: "https://rpc.mainnet.near.org",
  explorer: "https://nearblocks.io",
  // stake.dao price price_QzmSvxbZqdbV0XbG6VD6KkbB, "100 $NEAR x 1 month = $1 credit"
  farmRewardRate: "7605141075366948",
};
/** The network an account lives on: `.near` names and 64-hex implicit accounts are mainnet, the rest testnet. */
export const netFor = id => (/\.near$|^[0-9a-f]{64}$/.test(String(id)) ? MAINNET : TESTNET);

export async function view(accountId, method, args = {}, net = TESTNET) {
  const res = await fetch(net.rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: "ballast", method: "query",
      params: { request_type: "call_function", finality: "final", account_id: accountId, method_name: method, args_base64: btoa(JSON.stringify(args)) },
    }),
  });
  if (!res.ok) throw new Error(`RPC ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.cause?.name || body.error.message || "RPC error");
  if (body.result?.error) throw new Error(body.result.error.includes("MethodNotFound") ? "not a Ballast vault" : body.result.error.slice(0, 120));
  return JSON.parse(new TextDecoder().decode(new Uint8Array(body.result.result)));
}

export const viewVault = id => view(id, "get_state", {}, netFor(id));
/** The vault's position in NEAR AI's farm (null if it has none). */
export const viewFarm = (id, s) => view(s.staking_contract, "get_farm_position", { account_id: id, product_id: s.ai_product_id }, netFor(id));

/** yoctoNEAR string to a float in NEAR (fine for display). */
export function yoctoToNear(y) {
  const b = BigInt(y);
  return Number(b / 10n ** 18n) / 1e6;
}

export const explorerUrl = (id, net = netFor(id)) => `${net.explorer}/address/${id}`;
