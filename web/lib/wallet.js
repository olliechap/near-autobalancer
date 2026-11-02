// NEAR wallet sign-in and signing for the dashboard, on NEAR Wallet Selector (bundled in vendor/wallet.js).
// The bundle is about 1.8 MB, so it loads only when someone opens the wallet list or returns signed in.
//
// Sign-in asks for no function-call key: every owner action goes to the wallet for approval.

const NETWORK = "testnet";
const SIGNED_IN_KEY = "ballast:wallet"; // set while signed in, so a reload knows to load the bundle
let selectorPromise = null;
let lib = null;

function remember(on) {
  try { on ? localStorage.setItem(SIGNED_IN_KEY, "1") : localStorage.removeItem(SIGNED_IN_KEY); } catch { /* only a hint */ }
}
export function probablySignedIn() {
  try {
    // MyNearWallet comes back with ?account_id=... after a redirect sign-in or a signed transaction
    return localStorage.getItem(SIGNED_IN_KEY) === "1" || new URLSearchParams(location.search).has("account_id");
  } catch { return false; }
}

export function selector() {
  if (!selectorPromise) {
    selectorPromise = import("../vendor/wallet.js").then(async w => {
      lib = w;
      const successUrl = location.origin + location.pathname;
      return w.setupWalletSelector({
        network: NETWORK,
        modules: [w.setupMyNearWallet({ successUrl, failureUrl: successUrl }), w.setupMeteorWallet(), w.setupHereWallet()],
      });
    });
  }
  return selectorPromise;
}

/** The wallets the picker offers: [{ id, name, icon, available }]. */
export async function wallets() {
  const s = await selector();
  return s.store.getState().modules.map(m => ({ id: m.id, name: m.metadata.name, icon: m.metadata.iconUrl, available: m.metadata.available !== false }));
}

/** The signed-in account id, or null. */
export async function accountId() {
  const s = await selector();
  const acc = s.store.getState().accounts.find(a => a.active) || s.store.getState().accounts[0];
  remember(!!acc);
  return acc ? acc.accountId : null;
}

/** Calls fn(accountId|null) whenever the signed-in account changes. */
export async function onAccount(fn) {
  const s = await selector();
  s.store.observable.subscribe(state => {
    const acc = state.accounts.find(a => a.active) || state.accounts[0];
    remember(!!acc);
    fn(acc ? acc.accountId : null);
  });
}

export async function signIn(walletId) {
  const s = await selector();
  const w = await s.wallet(walletId);
  const accounts = await w.signIn({}); // browser wallets redirect away here and come back signed in
  remember(true);
  return accounts && accounts[0] ? accounts[0].accountId : null;
}

export async function signOut() {
  remember(false);
  const s = await selector();
  if (!s.isSignedIn()) return;
  const w = await s.wallet();
  await w.signOut();
}

/**
 * Sign and send one function call. gasTgas in teragas, deposit in yoctoNEAR (string).
 * Browser wallets (MyNearWallet) redirect to approve and come back; injected ones (Meteor, HERE) resolve here.
 */
export async function call(receiverId, methodName, args, { gasTgas = 100, deposit = "0" } = {}) {
  const s = await selector();
  const w = await s.wallet();
  const action = lib.actionCreators.functionCall(methodName, args, BigInt(gasTgas) * 10n ** 12n, BigInt(deposit));
  return w.signAndSendTransaction({ receiverId, actions: [action] });
}

/** Turn a wallet error into one plain sentence. */
export function explain(err) {
  const msg = String(err && (err.message || err)).replace(/\s+/g, " ");
  if (/reject|cancel|denied|closed/i.test(msg)) return "You cancelled it in the wallet.";
  const panic = msg.match(/Smart contract panicked: ([^"\\]+)/);
  if (panic) return `The vault refused: ${panic[1]}.`;
  return msg.slice(0, 200);
}
