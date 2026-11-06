// NEAR wallet sign-in and signing for the dashboard.
//
// Two routes:
//   * HOT Wallet's browser extension (mainnet), talked to directly through `window.hotExtension` when it is
//     installed: no bundle to load, the extension pops up to approve.
//   * NEAR Wallet Selector (bundled in vendor/wallet.js) for MyNearWallet, Meteor and HERE, on testnet or
//     mainnet. The bundle is about 1.8 MB, so it loads only when someone opens the wallet list or returns
//     signed in.
//
// Sign-in asks for no function-call key: every owner action goes to the wallet for approval.

const SIGNED_IN_KEY = "ballast:wallet"; // "<network>" or "<network>:hot" while signed in, so a reload knows how
const HOT_ID = "hot-wallet";
let network = "testnet";
let selectorPromise = null;
let selectorNetwork = null;
let lib = null;
let hotAccount = null;

const hot = () => (typeof window !== "undefined" ? window.hotExtension : null);
function stored() {
  try { return localStorage.getItem(SIGNED_IN_KEY); } catch { return null; }
}
function remember(on, via = "") {
  try { on ? localStorage.setItem(SIGNED_IN_KEY, network + (via ? ":" + via : "")) : localStorage.removeItem(SIGNED_IN_KEY); } catch { /* only a hint */ }
}
const usingHot = () => (stored() || "").endsWith(":hot");

/** Point the wallet at "testnet" or "mainnet". Changing it drops the loaded selector. */
export function setNetwork(n) {
  if (n === network) return;
  network = n;
  if (selectorNetwork && selectorNetwork !== n) { selectorPromise = null; selectorNetwork = null; }
}
export const getNetwork = () => network;

export function probablySignedIn() {
  try {
    // MyNearWallet comes back with ?account_id=... after a redirect sign-in or a signed transaction
    return !!stored() || new URLSearchParams(location.search).has("account_id");
  } catch { return false; }
}
/** The network the last sign-in was on, if any. */
export function signedInNetwork() {
  const v = stored();
  return v ? v.split(":")[0].replace(/^1$/, "testnet") : null;
}

export function selector() {
  if (!selectorPromise) {
    selectorNetwork = network;
    selectorPromise = import("../vendor/wallet.js").then(async w => {
      lib = w;
      const successUrl = location.origin + location.pathname;
      return w.setupWalletSelector({
        network,
        modules: [w.setupMyNearWallet({ successUrl, failureUrl: successUrl }), w.setupMeteorWallet(), w.setupHereWallet()],
      });
    });
  }
  return selectorPromise;
}

/** The wallets the picker offers: [{ id, name, icon, available }]. */
export async function wallets() {
  const out = [];
  if (network === "mainnet") out.push({ id: HOT_ID, name: "HOT Wallet", icon: "https://storage.herewallet.app/logo.png", available: !!hot() });
  const s = await selector();
  return out.concat(s.store.getState().modules.map(m => ({ id: m.id, name: m.metadata.name, icon: m.metadata.iconUrl, available: m.metadata.available !== false })));
}

/** The signed-in account id, or null. */
export async function accountId() {
  if (usingHot()) {
    if (hotAccount) return hotAccount;
    if (!hot()) return null;
    try { hotAccount = (await hot().request("near:signIn", {})).accountId; } catch { hotAccount = null; }
    remember(!!hotAccount, "hot");
    return hotAccount;
  }
  const s = await selector();
  const acc = s.store.getState().accounts.find(a => a.active) || s.store.getState().accounts[0];
  remember(!!acc);
  return acc ? acc.accountId : null;
}

/** Calls fn(accountId|null) whenever the signed-in account changes. */
export async function onAccount(fn) {
  if (usingHot()) { hot()?.subscribe?.("near:accountsChanged", e => fn(e?.accounts?.[0]?.accountId ?? e?.accountId ?? null)); return; }
  const s = await selector();
  s.store.observable.subscribe(state => {
    const acc = state.accounts.find(a => a.active) || state.accounts[0];
    remember(!!acc);
    fn(acc ? acc.accountId : null);
  });
}

export async function signIn(walletId) {
  if (walletId === HOT_ID) {
    if (!hot()) throw new Error("HOT Wallet's extension isn't installed in this browser.");
    const r = await hot().request("near:signIn", {});
    hotAccount = r.accountId;
    remember(true, "hot");
    return hotAccount;
  }
  const s = await selector();
  const w = await s.wallet(walletId);
  const accounts = await w.signIn({}); // browser wallets redirect away here and come back signed in
  remember(true);
  return accounts && accounts[0] ? accounts[0].accountId : null;
}

export async function signOut() {
  if (usingHot()) {
    remember(false);
    hotAccount = null;
    try { await hot()?.request("near:signOut", {}); } catch { /* already out */ }
    return;
  }
  remember(false);
  const s = await selector();
  if (!s.isSignedIn()) return;
  const w = await s.wallet();
  await w.signOut();
}

/**
 * Sign and send one function call. gasTgas in teragas, deposit in yoctoNEAR (string).
 * Browser wallets (MyNearWallet) redirect to approve and come back; injected ones (HOT, Meteor, HERE) resolve here.
 */
export async function call(receiverId, methodName, args, { gasTgas = 100, deposit = "0" } = {}) {
  const gas = (BigInt(gasTgas) * 10n ** 12n).toString();
  if (usingHot()) {
    const actions = [{ type: "FunctionCall", params: { methodName, args, gas, deposit: String(deposit) } }];
    const { transactions } = await hot().request("near:signAndSendTransactions", {
      transactions: [{ receiverId, actions, signerId: hotAccount ?? undefined }],
    });
    return transactions[0];
  }
  const s = await selector();
  const w = await s.wallet();
  const action = lib.actionCreators.functionCall(methodName, args, BigInt(gas), BigInt(deposit));
  return w.signAndSendTransaction({ receiverId, actions: [action] });
}

/** Turn a wallet error into one plain sentence. */
export function explain(err) {
  const msg = String(err && (err.message || (typeof err === "object" ? JSON.stringify(err) : err))).replace(/\s+/g, " ");
  if (/reject|cancel|denied|closed/i.test(msg)) return "You cancelled it in the wallet.";
  const panic = msg.match(/Smart contract panicked: ([^"\\]+)/);
  if (panic) return `The vault refused: ${panic[1]}.`;
  return msg.slice(0, 200);
}
