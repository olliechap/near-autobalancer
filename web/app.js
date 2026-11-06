// Ballast dashboard. Two sources behind one screen:
//   demo  — a 100,000 NEAR vault simulated in the browser with VaultSim (the agent's own policy code),
//           so the budget, guard rails and approvals all respond live;
//   live  — a real vault on NEAR testnet or mainnet, read with the RPC `get_state` view. Signed in with a NEAR wallet as
//           the vault's owner, you approve moves, change guard rails, deposit, exit and withdraw from here;
//           otherwise it is read-only and shows the owner's command line instead.
import { defaultScenario } from "./lib/sim.js";
import { VaultSim } from "./lib/vault-sim.js";
import { nextAction, creditRateFromFarm } from "./lib/policy.js";
import { viewVault, viewFarm, yoctoToNear, explorerUrl, netFor, TESTNET } from "./lib/near.js";
import * as wallet from "./lib/wallet.js";

const $ = id => document.getElementById(id);
const fmtNear = v => (v === 0 ? "0" : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString("en-US") : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(3));
const fmtUsd = v => (v === 0 ? "$0" : Math.abs(v) >= 100 ? "$" + Math.round(v).toLocaleString("en-US") : Math.abs(v) >= 1 ? "$" + v.toFixed(2) : "$" + v.toPrecision(2));
const pct = v => Math.round(v * 100) + "%";
const dayHour = h => `d${Math.floor(h / 24) + 1} ${String(h % 24).padStart(2, "0")}h`;
const COLORS = { ai: "#6a5ad0", yield: "#2f8f6a", flight: "#c98a2c", ink: "#1c1b19", alarm: "#d03b3b", muted: "#8b877f" };
const SESSION_KEY = "ballast:session";

const App = {
  mode: null, // "demo" | "live"
  budget: 100, approve: false, maxAi: 0.9, buffer: 3, spike: 2,
  sc: null, sim: null, compare: null,
  playing: false, speed: 16, clock: 0, lastFrame: 0, dirty: true,
  live: null, liveTimer: 0,
  net: TESTNET, // the live vault's network
  account: null, // signed-in NEAR account, if any
  confirm: null, // an owner action waiting for its second click
};
const ONE_YOCTO = "1";
const txUrl = h => `${App.net.explorer}/txns/${h}`;

// ================================================================ login
function session(v) {
  try {
    if (v === undefined) return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
    if (v === null) sessionStorage.removeItem(SESSION_KEY);
    else sessionStorage.setItem(SESSION_KEY, JSON.stringify(v));
  } catch { return null; }
}
$("demo").addEventListener("click", () => enterDemo());
$("watch").addEventListener("submit", async e => {
  e.preventDefault();
  const raw = $("vault-id").value.trim().toLowerCase();
  const err = $("watch-error");
  err.hidden = true;
  const candidates = raw.startsWith("vault.") ? [raw] : [raw, "vault." + raw];
  const btn = e.submitter || e.target.querySelector("button[type=submit]");
  btn.disabled = true;
  btn.textContent = "Reading…";
  try {
    let found = null, lastErr = null;
    for (const id of candidates) {
      try { found = { id, state: await viewVault(id) }; break; } catch (x) { lastErr = x; }
    }
    if (!found) throw lastErr;
    enterLive(found.id, found.state);
  } catch (x) {
    err.textContent = `Couldn't read a Ballast vault at ${candidates.join(" or ")}: ${x.message}`;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "Watch";
  }
});
$("logout").addEventListener("click", () => {
  session(null);
  if (App.account) { wallet.signOut().catch(() => {}); App.account = null; }
  App.playing = false;
  clearInterval(App.liveTimer);
  App.mode = null;
  $("dash").hidden = true;
  $("login").hidden = false;
  history.replaceState(null, "", "app.html");
});

function showDash() {
  $("login").hidden = true;
  $("dash").hidden = false;
  document.body.dataset.mode = App.mode;
  for (const el of document.querySelectorAll(".demo-only")) el.hidden = App.mode !== "demo";
  $("clock").hidden = App.mode !== "demo";
  $("live-note").hidden = App.mode !== "live";
  document.querySelector(".compare").hidden = App.mode !== "demo";
  $("spike").closest("label").hidden = App.mode !== "demo";
  $("budget-range").hidden = App.mode !== "demo";
  document.querySelector(".mode").hidden = App.mode !== "demo";
  for (const id of ["chart-usage", "chart-stake"]) $(id).previousElementSibling.hidden = App.mode !== "demo";
  renderWho();
}

// ================================================================ wallet
const isOwner = () => App.mode === "live" && !!App.account && App.account === App.live.state.owner_id;
function renderWho() {
  const who = $("who");
  if (!App.account) { who.innerHTML = App.mode === "live" ? `<button class="link" id="who-connect" type="button">connect wallet</button>` : ""; }
  else who.innerHTML = `<b>${escapeHtml(App.account)}</b>${App.mode === "live" ? (isOwner() ? " · owner" : " · not the owner") : ""}`;
  $("who-connect")?.addEventListener("click", openWallets);
}
$("connect").addEventListener("click", openWallets);
async function openWallets() {
  const dlg = $("wallets"), list = $("wallet-list");
  list.innerHTML = `<li class="muted">Loading wallets…</li>`;
  if (!dlg.open) dlg.showModal();
  try {
    const ws = await wallet.wallets();
    list.innerHTML = "";
    for (const w of ws) {
      const li = document.createElement("li"), b = document.createElement("button");
      b.type = "button";
      b.innerHTML = `${w.icon ? `<img src="${escapeHtml(w.icon)}" alt="">` : ""}<span>${escapeHtml(w.name)}</span><span class="muted">${w.available ? "" : "not installed"}</span>`;
      b.addEventListener("click", async () => {
        b.disabled = true;
        b.querySelector(".muted").textContent = "opening…";
        try {
          const acc = await wallet.signIn(w.id);
          dlg.close();
          if (acc) await afterSignIn(acc);
        } catch (x) {
          b.disabled = false;
          b.querySelector(".muted").textContent = wallet.explain(x);
        }
      });
      li.append(b);
      list.append(li);
    }
  } catch (x) {
    list.innerHTML = `<li class="error">Couldn't load wallets: ${escapeHtml(x.message)}</li>`;
  }
}
dialogClickOutside($("wallets"));
function dialogClickOutside(d) { d.addEventListener("click", e => { if (e.target === d) d.close(); }); }

/** Signed in: open the account's vault if it has one, else say so on the login card. */
async function afterSignIn(acc) {
  App.account = acc;
  if (App.mode === "live") { App.dirty = true; renderWho(); return; }
  const id = acc.startsWith("vault.") ? acc : `vault.${acc}`;
  try {
    enterLive(id, await viewVault(id));
  } catch {
    const err = $("connect-error");
    err.innerHTML = `Signed in as <b>${escapeHtml(acc)}</b>, but there is no Ballast vault at <code>${escapeHtml(id)}</code> on ${netFor(acc).id} yet. Watch any vault below, or open the demo.`;
    err.hidden = false;
  }
}

/** Sign and send one owner call, with progress and the result in the owner note. */
async function act(label, method, args, { gasTgas = 30, deposit = ONE_YOCTO } = {}) {
  const note = $("owner-note");
  App.confirm = null;
  App.dirty = true;
  note.textContent = `${label}: waiting for your wallet…`;
  try { sessionStorage.setItem("ballast:pending", label); } catch { /* only for the redirect message */ }
  try {
    const out = await wallet.call(App.live.id, method, args, { gasTgas, deposit });
    const hash = out?.transaction?.hash || out?.transaction_outcome?.id;
    note.innerHTML = `${escapeHtml(label)}: done${hash ? ` · <a href="${txUrl(hash)}" target="_blank" rel="noopener">transaction ↗</a>` : ""}`;
    try { sessionStorage.removeItem("ballast:pending"); } catch { /* fine */ }
    await refreshLive();
  } catch (x) {
    note.textContent = `${label}: ${wallet.explain(x)}`;
  }
  App.dirty = true;
}
/** Two-click confirmation for actions that move money out or unwind the vault. */
function confirmThen(btn, key, label, fn) {
  if (App.confirm === key) return fn();
  App.confirm = key;
  btn.textContent = `Confirm: ${label}?`;
  btn.classList.add("confirm");
  setTimeout(() => { if (App.confirm === key) { App.confirm = null; App.dirty = true; } }, 4000);
}
$("deposit").addEventListener("click", () => {
  const amt = Math.max(0, +$("deposit-amt").value || 0);
  if (amt > 0) act(`Deposit ${amt} NEAR`, "deposit", {}, { deposit: nearToYocto(amt) });
});
$("exit").addEventListener("click", e => {
  const s = App.live.state;
  if (s.exiting) act("Cancel exit", "cancel_exit", {});
  else confirmThen(e.currentTarget, "exit", "unwind both sides", () => act("Exit", "exit", {}));
});
$("withdraw").addEventListener("click", e => {
  const liquid = yoctoToNear(App.live.state.liquid);
  confirmThen(e.currentTarget, "withdraw", `withdraw ${fmtNear(liquid)} NEAR to ${App.live.state.owner_id}`, () => act(`Withdraw ${fmtNear(liquid)} NEAR`, "withdraw", { amount: null }));
});
$("save-policy").addEventListener("click", () => {
  const p = { ...App.live.state.policy, max_ai_bps: Math.round(App.maxAi * 10000), buffer_days: App.buffer };
  if (budgetOnChain()) p.budget_micro_usd_week = String(Math.round(App.budget * 1e6));
  if (p.min_ai_bps > p.max_ai_bps) p.min_ai_bps = p.max_ai_bps;
  act("Save guard rails", "set_policy", { policy: p });
});
function policyDirty() {
  if (App.mode !== "live") return false;
  const p = App.live.state.policy;
  return Math.round(App.maxAi * 10000) !== p.max_ai_bps || App.buffer !== p.buffer_days ||
    (budgetOnChain() && Math.round(App.budget * 1e6) !== Number(p.budget_micro_usd_week || 0));
}
/** Vault 0.2 and later store the weekly budget in the policy (an optional field, null until first set). */
function budgetOnChain() {
  const s = App.live?.state;
  return !!s && ("budget_micro_usd_week" in s.policy || "yield_earned" in s);
}

// ================================================================ demo vault
function scenario() {
  const sc = defaultScenario();
  sc.budgetUsdWeek = App.budget;
  sc.spikeMultiplier = App.spike;
  sc.params = { ...sc.params, maxAiShare: App.maxAi, bufferDays: App.buffer };
  return sc;
}
/** Rebuild the month with the current settings, as if they had been set on day 1, and return to `hour`. */
function rebuild(hour = App.sim ? App.sim.hour : 0) {
  App.sc = scenario();
  const sim = new VaultSim(App.sc, { approve: false });
  while (sim.hour < hour && !sim.done) sim.tick();
  sim.approveMode = App.approve;
  App.sim = sim;
  App.clock = sim.hour;
  App.compare = ["ballast", "static", "all-ai"].map(s => new VaultSim(App.sc, { strategy: s }).runToEnd());
  App.dirty = true;
}
function enterDemo() {
  App.mode = "demo";
  App.budget = 100;
  $("budget").value = 100;
  $("budget").step = "1";
  $("budget-range").value = 100;
  session({ mode: "demo" });
  $("vault-name").textContent = "vault.demo.near";
  $("mode-chip").textContent = "demo · simulated month";
  $("mode-chip").className = "chip";
  showDash();
  rebuild(0);
  // start a few days in, so there is history to read
  seek(24 * 4);
  render();
}
function seek(hour) {
  hour = Math.max(0, Math.min(App.sc.days * 24, Math.round(hour)));
  if (hour < App.sim.hour) rebuild(hour);
  while (App.sim.hour < hour && !App.sim.done) {
    App.sim.tick();
    if (App.sim.pending && App.playing) { App.playing = false; break; }
  }
  App.clock = App.sim.hour;
  App.dirty = true;
}
function setPlaying(on) {
  if (on && App.sim.done) rebuild(0);
  App.playing = on;
  App.lastFrame = performance.now();
  $("play").textContent = on ? "❚❚ pause" : "▶ play month";
  $("play").setAttribute("aria-pressed", String(on));
}
$("play").addEventListener("click", () => setPlaying(!App.playing));
$("speed").addEventListener("change", e => { App.speed = +e.target.value; });
$("scrub").addEventListener("input", e => { setPlaying(false); seek(+e.target.value); render(); });

function frame(now) {
  if (App.mode === "demo" && App.playing) {
    const dt = Math.min(0.1, (now - App.lastFrame) / 1000);
    App.clock += dt * App.speed;
    let wasPending = !!App.sim.pending;
    while (App.sim.hour < App.clock && !App.sim.done) {
      App.sim.tick();
      if (App.sim.pending && !wasPending) { setPlaying(false); flash($("approvals")); break; }
    }
    if (App.sim.done) setPlaying(false);
    App.dirty = true;
  }
  App.lastFrame = now;
  if (App.dirty && now - (App.lastRender || 0) > 90) { render(); App.lastRender = now; }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
function flash(el) {
  el.closest(".card").animate([{ outline: "3px solid #1c1b19" }, { outline: "3px solid transparent" }], { duration: 900, iterations: 2 });
}

// ---------------------------------------------------------------- settings
function onBudget(v, from) {
  v = App.mode === "live" ? Math.max(0.0001, +v || 0) : Math.max(1, Math.min(5000, Math.round(+v || 0)));
  App.budget = v;
  if (from !== "num") $("budget").value = v;
  if (from !== "range") $("budget-range").value = Math.min(400, v);
  if (App.mode === "demo") rebuild();
  App.dirty = true;
}
$("budget").addEventListener("change", e => onBudget(e.target.value, "num"));
$("budget-range").addEventListener("input", e => onBudget(e.target.value, "range"));
for (const r of document.querySelectorAll('input[name="mode"]')) r.addEventListener("change", e => {
  App.approve = e.target.value === "ask";
  if (App.sim) { App.sim.approveMode = App.approve; if (!App.approve && App.sim.pending) App.sim.approve(); }
  App.dirty = true;
});
$("max-ai").addEventListener("input", e => { App.maxAi = +e.target.value / 100; $("max-out").textContent = e.target.value + "%"; if (App.mode === "demo") rebuild(); App.dirty = true; });
$("buffer").addEventListener("input", e => { App.buffer = +e.target.value; $("buf-out").textContent = e.target.value + (e.target.value === "1" ? " day" : " days"); if (App.mode === "demo") rebuild(); App.dirty = true; });
$("spike").addEventListener("input", e => {
  App.spike = +e.target.value;
  $("spike-out").textContent = App.spike <= 1 ? "none" : `x${App.spike} from day 11`;
  if (App.mode === "demo") rebuild();
  App.dirty = true;
});

// ================================================================ live vault (testnet, read-only)
async function enterLive(id, state) {
  App.mode = "live";
  // a testnet vault is tiny: start the budget at what the agent last reported, not $100
  const burn = state.last_report ? Number(state.last_report.burn_micro_usd_per_day) / 1e6 : 0;
  if (burn > 0) { App.budget = +(burn * 7).toPrecision(2); $("budget").value = App.budget; $("budget").step = "any"; }
  else {
    // no usage reported yet: start at what the vault's current AI stake already covers
    const covered = creditRateFromFarm(netFor(id).farmRewardRate) * yoctoToNear(state.ai_staked) * 7;
    if (covered > 0) { App.budget = +covered.toPrecision(2); $("budget").value = App.budget; $("budget").step = "any"; }
  }
  session({ mode: "live", id });
  App.live = { id, state, read: new Date(), farm: null };
  App.net = netFor(id);
  wallet.setNetwork(App.net.id);
  viewFarm(id, state).then(f => { if (App.live?.id === id) { App.live.farm = f; App.dirty = true; } }).catch(() => {});
  // guard rails start from what the vault has stored
  App.maxAi = state.policy.max_ai_bps / 10000;
  App.buffer = state.policy.buffer_days;
  $("max-ai").value = Math.round(App.maxAi * 100); $("max-out").textContent = Math.round(App.maxAi * 100) + "%";
  $("buffer").value = App.buffer; $("buf-out").textContent = App.buffer + (App.buffer === 1 ? " day" : " days");
  if (state.policy.budget_micro_usd_week != null && Number(state.policy.budget_micro_usd_week) > 0) {
    App.budget = Number(state.policy.budget_micro_usd_week) / 1e6; $("budget").value = App.budget;
  }
  $("vault-name").textContent = id;
  $("mode-chip").textContent = `${App.net.id} · live`;
  $("mode-chip").className = "chip live";
  showDash();
  App.dirty = true;
  clearInterval(App.liveTimer);
  App.liveTimer = setInterval(refreshLive, 15000);
  render();
}
async function refreshLive() {
  if (App.mode !== "live" || !App.live) return;
  try {
    App.live.state = await viewVault(App.live.id); App.live.read = new Date(); App.live.error = null;
    App.live.farm = await viewFarm(App.live.id, App.live.state).catch(() => App.live.farm);
  }
  catch (x) { App.live.error = x.message; }
  App.dirty = true;
}
function liveModel() {
  const s = App.live.state;
  const n = k => yoctoToNear(s[k]);
  const c = creditRateFromFarm(App.net.farmRewardRate);
  const rep = s.last_report;
  const burn = rep ? Number(rep.burn_micro_usd_per_day) / 1e6 : App.budget / 7;
  const credits = rep ? Number(rep.credit_balance_micro_usd) / 1e6 : 0;
  const ai = n("ai_staked"), total = n("total");
  const net = burn - c * ai;
  return {
    total, ai, yld: n("yield_staked"), flight: n("ai_unstaking") + n("yield_unstaking") + n("ai_withdrawable"), liquid: n("liquid"),
    // credits NEAR AI's farm has paid this vault so far ($1 per reward unit)
    farmEarned: App.live.farm ? Number(BigInt(App.live.farm.total_earned_reward_units || "0") / 10n ** 12n) / 1e12 : null,
    target: n("target_ai"), c, burn, credits, runway: net <= 0 ? Infinity : credits / net, report: rep,
    books: {
      liquid: n("liquid"), aiStaked: ai, aiUnstaking: n("ai_unstaking"), aiWithdrawable: n("ai_withdrawable"),
      yieldStaked: n("yield_staked"), yieldUnstaking: n("yield_unstaking"), yieldCanWithdraw: s.yield_can_withdraw,
    },
  };
}

// ================================================================ render
function render() {
  App.dirty = false;
  if (App.mode === "demo") renderDemo();
  else if (App.mode === "live") renderLive();
}

function stat(label, value, sub, alarm) {
  return `<div class="${alarm ? "alarm" : ""}"><dt>${label}</dt><dd>${value}${sub ? ` <small>${sub}</small>` : ""}</dd></div>`;
}
function renderDemo() {
  const s = App.sim, sc = App.sc, h = s.hours[s.hours.length - 1];
  const c = sc.market.creditUsdPerNearDay;
  const p = s.plan();
  const day = Math.min(sc.days, Math.floor(s.hour / 24) + 1);
  $("day-label").textContent = s.done ? `day ${sc.days} of ${sc.days} · month over` : `day ${day} of ${sc.days} · ${String(s.hour % 24).padStart(2, "0")}:00`;
  $("scrub").max = sc.days * 24;
  $("scrub").value = s.hour;
  const throttledNow = !!(h && h.throttled);
  $("stats").innerHTML =
    stat("vault", fmtNear(s.total), "NEAR") +
    stat("on NEAR AI", pct(s.aiShare), `target ${pct(s.target / s.total)}`) +
    stat("AI credits", fmtUsd(s.credits), throttledNow ? "throttled now" : isFinite(p.runwayDays) ? `${p.runwayDays.toFixed(1)} days left` : "growing", throttledNow) +
    stat("NEAR earned", fmtNear(s.yieldEarned), `${s.throttled}h throttled`, s.throttled > 0);

  renderPlan({ total: s.total, c, nearUsd: sc.market.nearUsd, apy: sc.market.apy * (1 - sc.market.commission), maxAi: App.maxAi, burn: p.burnUsdDay });
  renderSplit({ ai: s.ai, flight: s.inFlight, yld: s.yld, liquid: s.liquid, target: s.target, total: s.total });
  renderApprovalsDemo();
  renderHistory(s.events.slice().reverse(), e => dayHour(e.t));
  $("hist-note").textContent = `${s.events.filter(e => e.kind === "rebalance").length} target changes`;
  renderCharts();
  renderCompare();
  postView({
    ai: s.ai, yield: s.yld, crateNear: s.total / 20,
    flights: [...s.aiOut.map(t => ({ ...t, dest: "yield" })), ...s.yldOut.map(t => ({ ...t, dest: "ai" }))].map(t => ({ amount: t.amount, dest: t.dest, progress: 1 - (t.readyAt - s.hour) / s.unbondHours })),
    tank: s.credits / Math.max(1e-9, p.bufferUsd * 2), throttled: throttledNow, demand: h ? (h.demandUsd * 24) / (sc.budgetUsdWeek / 7) : 1,
    coin: App.playing && Math.random() < 0.5,
  });
}

function renderPlan({ total, c, nearUsd, apy, maxAi, burn }) {
  const weekly = App.budget;
  const need = weekly / 7 / c;
  const cap = maxAi * total;
  const ai = Math.min(need, cap);
  const rest = total - ai;
  const yieldWeek = (rest * apy) / 52;
  const covered = (ai * c * 7) / weekly;
  let html = `To cover <b>${fmtUsd(weekly)}</b> a week, Ballast keeps <b>${fmtNear(need)} NEAR</b> on NEAR AI (${pct(need / total)} of the vault). `;
  if (need > cap) html += `<span class="gap">Your guard rails cap that at ${pct(maxAi)}, which covers ${pct(covered)}: about ${fmtUsd(weekly - ai * c * 7)} a week short.</span> `;
  html += `The other <b>${fmtNear(Math.max(0, rest))} NEAR</b> earns about <b>${fmtNear(yieldWeek)} NEAR</b> a week (${fmtUsd(yieldWeek * nearUsd)}).`;
  if (burn > (weekly / 7) * 1.15) html += ` Right now usage is running at <b>${fmtUsd(burn * 7)}</b> a week, so the agent is holding more.`;
  $("plan-line").innerHTML = html;
}

function renderSplit({ ai, flight, yld, liquid, target, total }) {
  const parts = [["ai", ai, "on NEAR AI · earns credits"], ["flight", flight, "unbonding · 4 epochs"], ["yield", yld, "staked for yield · earns NEAR"], ["liquid", liquid, "liquid in the vault"]];
  const bar = $("split-bar");
  bar.innerHTML = parts.filter(([, v]) => v / total > 0.002).map(([k, v]) => `<div class="seg ${k}" style="flex:${v}"></div>`).join("") +
    `<div class="target" style="left:${(target / total) * 100}%" data-label="target ${pct(target / total)}"></div>`;
  bar.setAttribute("aria-label", parts.map(([, v, l]) => `${fmtNear(v)} NEAR ${l}`).join(", ") + `; target ${pct(target / total)} on NEAR AI`);
  $("split-legend").innerHTML = parts.filter(([k, v]) => k !== "liquid" || v > 0.5).map(([k, v, l]) =>
    `<li><span class="sw" style="background:${k === "flight" ? `repeating-linear-gradient(135deg, ${COLORS.flight} 0 2px, #fff 2px 4px)` : k === "liquid" ? "#d9d6cf" : COLORS[k]}"></span><b>${fmtNear(v)}</b> ${l}</li>`).join("");
  $("split-total").textContent = `${fmtNear(total)} NEAR`;
}

function renderApprovalsDemo() {
  const s = App.sim, el = $("approvals");
  if (s.pending) {
    const p = s.pending, dir = p.target > s.target ? "toward NEAR AI" : "toward yield";
    const delta = Math.abs(p.target - s.target);
    el.innerHTML = `<div class="proposal" role="group" aria-label="Pending move">
      <div class="what">Move ${fmtNear(delta)} NEAR ${dir}</div>
      <div>New target: ${fmtNear(p.target)} NEAR on NEAR AI (${pct(p.target / s.total)}), up from ${pct(s.target / s.total)}.</div>
      <div class="why">${escapeHtml(p.reason)}. Asked ${dayHour(p.t)}.</div>
      <div class="actions"><button class="button" id="approve">Approve</button><button class="button ghost" id="reject">Not now</button></div>
    </div>`;
    $("approve").onclick = () => { s.approve(); App.dirty = true; render(); };
    $("reject").onclick = () => { s.reject(); App.dirty = true; render(); };
  } else if (App.approve) {
    el.innerHTML = `<p class="empty">Nothing to approve. The agent will ask here before it moves stake, and pauses the month when it does.</p>`;
  } else {
    el.innerHTML = `<p class="empty">Autopilot is on: the agent moves stake inside your guard rails and logs every move. Switch to “ask me first” to approve each one.</p>`;
  }
}

function kindClass(kind) {
  if (kind === "StakeAi") return "to-ai";
  if (kind === "StakeYield") return "to-yield";
  if (kind.startsWith("Unstake")) return "flight";
  if (kind === "rejected") return "owner";
  return "";
}
const KIND_LABEL = { rebalance: "new target", StakeAi: "staked for AI", StakeYield: "staked for yield", UnstakeAi: "unbonding from AI", UnstakeYield: "unbonding from yield", rejected: "owner said not now" };
function renderHistory(events, when) {
  const list = $("history");
  if (!events.length) { list.innerHTML = `<li><span class="when">·</span><span class="empty">No moves yet.</span></li>`; return; }
  list.innerHTML = events.slice(0, 60).map(e => `<li><span class="when">${when(e)}</span><span class="kind ${kindClass(e.kind)}">${KIND_LABEL[e.kind] || e.kind}</span><span class="detail">${escapeHtml(e.amount != null ? fmtNear(e.amount) + " NEAR" : e.kind === "rebalance" && e.target != null ? `${fmtNear(e.target)} NEAR on NEAR AI: ${e.reason}` : e.detail.replace(/^target /, ""))}</span></li>`).join("");
}

function renderCompare() {
  const names = { ballast: "Ballast agent", static: "set and forget", "all-ai": "all in on AI" };
  $("cmp-rows").innerHTML = App.compare.map(r => `<tr class="${r.strategy === "ballast" ? "ours" : ""}"><td>${names[r.strategy]}</td><td>${fmtNear(r.yieldEarnedNear)}</td><td class="${r.throttledHours ? "bad" : ""}">${r.throttledHours}</td><td>${fmtUsd(r.endCreditsUsd)}</td></tr>`).join("");
}

// ---------------------------------------------------------------- charts (hand-drawn SVG)
const VB = { w: 640, h: 132, l: 46, r: 10, t: 8, b: 18 };
function renderCharts() {
  const s = App.sim, sc = App.sc, hours = s.hours, N = sc.days * 24;
  const c = sc.market.creditUsdPerNearDay;
  const p = s.plan();
  const step = 3;
  const idx = [];
  for (let k = 0; k < hours.length; k += step) idx.push(k);
  if (hours.length) idx.push(hours.length - 1);

  // 1. credits: balance so far, buffer line, 7-day forecast at the current stake and burn
  const fc = [];
  const slope = (c * s.ai - p.burnUsdDay) / 24;
  for (let k = 0; k <= 24 * 7 && s.hour + k <= N; k += 6) fc.push([s.hour + k, Math.max(0, s.credits + slope * k)]);
  const creditMax = niceMax(Math.max(p.bufferUsd * 2.2, ...hours.map(x => x.creditsUsd), ...fc.map(x => x[1]), 1));
  const throttled = hours.filter(x => x.throttled).map(x => x.t);
  chart($("chart-credits"), {
    xMax: N, yMax: creditMax, yFmt: fmtUsd, height: 150,
    lines: [
      { name: "credits", color: COLORS.ai, pts: idx.map(k => [hours[k].t, hours[k].creditsUsd]) },
      { name: "forecast", color: COLORS.ai, dash: "4 3", pts: fc },
    ],
    hlines: [{ y: p.bufferUsd, label: `buffer ${App.buffer}d` }],
    ticks: throttled, playhead: s.hour,
    hover: t => { const x = hours[Math.min(hours.length - 1, t)]; return x && `<b>${dayHour(x.t)}</b><br><span class="sw" style="background:${COLORS.ai}"></span>credits ${fmtUsd(x.creditsUsd)}${x.throttled ? `<br><span style="color:${COLORS.alarm}">throttled</span>` : ""}`; },
  });
  $("fc-note").textContent = slope >= 0 ? "credits growing at this stake" : `at this stake, dry in ${(s.credits / (-slope * 24)).toFixed(1)} days`;

  // 2. usage vs accrual, $/day (rolling 24h usage)
  const usage = idx.map(k => { let a = 0, n = 0; for (let j = Math.max(0, k - 23); j <= k; j++) { a += hours[j].demandUsd; n++; } return [hours[k].t, (a / n) * 24]; });
  const accrual = idx.map(k => [hours[k].t, c * hours[k].aiNear]);
  chart($("chart-usage"), {
    xMax: N, yMax: niceMax(Math.max(...usage.map(x => x[1]), ...accrual.map(x => x[1]), App.budget / 7 * 1.5)), yFmt: fmtUsd, height: 120,
    lines: [{ name: "usage", color: COLORS.ink, pts: usage }, { name: "earned", color: COLORS.ai, pts: accrual }],
    hlines: [{ y: App.budget / 7, label: "budget" }], playhead: s.hour,
    hover: t => { const k = Math.min(hours.length - 1, t); const u = usage.reduce((b, x) => (Math.abs(x[0] - k) < Math.abs(b[0] - k) ? x : b), usage[0]); return hours[k] && `<b>${dayHour(k)}</b><br><span class="sw" style="background:${COLORS.ink}"></span>usage ${fmtUsd(u[1])}/day<br><span class="sw" style="background:${COLORS.ai}"></span>credits earned ${fmtUsd(c * hours[k].aiNear)}/day`; },
  });
  $("usage-legend").innerHTML = legend([["usage", COLORS.ink, "line"], ["credits earned", COLORS.ai, "line"]]);

  // 3. stake over time, stacked: AI, in flight, yield
  chart($("chart-stake"), {
    xMax: N, yMax: s.total, yFmt: v => (v === 0 ? "0" : Math.round(v / 1000) + "k"), height: 120,
    stack: idx.map(k => [hours[k].t, hours[k].aiNear, hours[k].inFlightNear + hours[k].liquidNear, hours[k].yieldNear]),
    stackColors: [COLORS.ai, COLORS.flight, COLORS.yield], playhead: s.hour,
    hover: t => { const x = hours[Math.min(hours.length - 1, t)]; return x && `<b>${dayHour(x.t)}</b><br><span class="sw" style="background:${COLORS.ai}"></span>AI ${fmtNear(x.aiNear)}<br><span class="sw" style="background:${COLORS.flight}"></span>unbonding ${fmtNear(x.inFlightNear + x.liquidNear)}<br><span class="sw" style="background:${COLORS.yield}"></span>yield ${fmtNear(x.yieldNear)}`; },
  });
  $("stake-legend").innerHTML = legend([["NEAR AI", COLORS.ai], ["unbonding", COLORS.flight], ["yield", COLORS.yield]]);
}
function legend(items) {
  return items.map(([n, col, kind]) => `<li><span class="sw ${kind || ""}" style="background:${col}"></span>${n}</li>`).join("");
}
function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
function chart(el, o) {
  const w = VB.w, h = o.height, l = VB.l, r = VB.r, t = VB.t, b = VB.b;
  const X = v => l + (v / o.xMax) * (w - l - r), Y = v => h - b - (v / o.yMax) * (h - t - b);
  let svg = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${el.previousElementSibling?.textContent || "chart"}">`;
  for (const f of [0, 0.5, 1]) svg += `<line class="grid-line" x1="${l}" x2="${w - r}" y1="${Y(o.yMax * f)}" y2="${Y(o.yMax * f)}"/><text x="${l - 6}" y="${Y(o.yMax * f) + 3}" text-anchor="end">${o.yFmt(o.yMax * f)}</text>`;
  const xLabel = o.xLabel || (d => (d === 0 ? "day 1" : d + 1));
  for (let d = 0; d <= o.xMax / 24; d += 5) svg += `<text x="${X(d * 24)}" y="${h - 4}" text-anchor="middle">${xLabel(d)}</text>`;
  if (o.stack) {
    const layers = o.stackColors.map((col, j) => {
      const top = o.stack.map(row => [row[0], row.slice(1, j + 2).reduce((a, v) => a + v, 0)]);
      const base = o.stack.map(row => [row[0], row.slice(1, j + 1).reduce((a, v) => a + v, 0)]);
      if (top.length < 2) return "";
      const d = "M" + top.map(([x, y]) => `${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join("L") + "L" + base.reverse().map(([x, y]) => `${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join("L") + "Z";
      return `<path d="${d}" fill="${col}" stroke="#fff" stroke-width="1"/>`;
    });
    svg += layers.join("");
  }
  for (const hl of o.hlines || []) svg += `<line x1="${l}" x2="${w - r}" y1="${Y(hl.y)}" y2="${Y(hl.y)}" stroke="${COLORS.muted}" stroke-dasharray="1 3" stroke-width="1.5"/><text x="${w - r}" y="${Y(hl.y) - 4}" text-anchor="end">${hl.label}</text>`;
  for (const ln of o.lines || []) {
    if (ln.pts.length < 2) continue;
    svg += `<path d="M${ln.pts.map(([x, y]) => `${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join("L")}" fill="none" stroke="${ln.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" ${ln.dash ? `stroke-dasharray="${ln.dash}"` : ""}/>`;
    if (ln.dash) {
      const [x, y] = ln.pts[ln.pts.length - 1], nearEnd = X(x) > w - r - 70;
      svg += `<text x="${nearEnd ? X(x) : X(x) + 4}" y="${nearEnd ? Y(y) - 6 : Y(y) + 3}" text-anchor="${nearEnd ? "end" : "start"}" class="label-ink">${ln.name}</text>`;
    }
  }
  if (o.ticks && o.ticks.length) {
    svg += `<path d="${o.ticks.map(tk => `M${X(tk).toFixed(1)},${h - b - 1}v-6`).join("")}" stroke="${COLORS.alarm}" stroke-width="1.5"/>`;
    svg += `<text x="${X(o.ticks[0])}" y="${h - b - 9}" fill="${COLORS.alarm}" style="fill:${COLORS.alarm}">throttled</text>`;
  }
  svg += `<line class="axis" x1="${l}" x2="${w - r}" y1="${h - b}" y2="${h - b}"/>`;
  if (o.playhead != null) svg += `<line class="playhead" x1="${X(o.playhead)}" x2="${X(o.playhead)}" y1="${t}" y2="${h - b}"/>`;
  svg += `<line class="hover-line" x1="0" x2="0" y1="${t}" y2="${h - b}" visibility="hidden"/>`;
  svg += `<rect x="${l}" y="0" width="${w - l - r}" height="${h}" fill="transparent" class="hit"/></svg>`;
  el.innerHTML = svg;
  const svgEl = el.firstChild, hit = svgEl.querySelector(".hit"), line = svgEl.querySelector(".hover-line"), tip = $("tip");
  const move = e => {
    const box = svgEl.getBoundingClientRect();
    const vx = ((e.clientX - box.left) / box.width) * w;
    const hour = Math.round(((vx - l) / (w - l - r)) * o.xMax);
    const html = hour >= 0 && hour <= (o.playhead ?? o.xMax) ? o.hover(hour) : null;
    if (!html) { tip.hidden = true; line.setAttribute("visibility", "hidden"); return; }
    line.setAttribute("x1", X(hour)); line.setAttribute("x2", X(hour)); line.setAttribute("visibility", "visible");
    tip.innerHTML = html;
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = Math.min(innerWidth - tw - 8, e.clientX + 14) + "px";
    tip.style.top = e.clientY + 14 + "px";
  };
  hit.addEventListener("pointermove", move);
  hit.addEventListener("pointerleave", () => { tip.hidden = true; line.setAttribute("visibility", "hidden"); });
}

// ---------------------------------------------------------------- live render
function renderLive() {
  const L = App.live, m = liveModel(), s = L.state;
  $("stats").innerHTML =
    stat("vault", fmtNear(m.total), "NEAR") +
    stat("on NEAR AI", pct(s.ai_bps / 10000), `target ${pct(s.target_ai_bps / 10000)}`) +
    stat("AI credits", fmtUsd(m.credits), isFinite(m.runway) ? `${m.runway.toFixed(1)} days left` : "growing", m.runway < 1) +
    stat("forecast burn", fmtUsd(m.burn), "a day") +
    (m.farmEarned != null ? stat("farm paid", fmtUsd(m.farmEarned), "in credits, so far") : "") +
    // vault 0.2.1 and later
    (s.yield_earned != null ? stat("yield earned", fmtNear(yoctoToNear(s.yield_earned)), "NEAR, all time") : "") +
    (s.topup_available != null ? stat("top-up left", fmtNear(yoctoToNear(s.topup_available)), "NEAR this window") : "");
  $("live-note").textContent = `Read from ${App.net.rpc.replace("https://", "")} at ${L.read.toLocaleTimeString()}${L.error ? ` · last refresh failed: ${L.error}` : ""} · refreshes every 15s${s.exiting ? " · vault is exiting" : ""}${s.busy ? " · a step is in progress" : ""}`;
  renderPlan({ total: m.total, c: m.c, nearUsd: 2.5, apy: 0.045 * 0.95, maxAi: s.policy.max_ai_bps / 10000, burn: m.burn });
  renderSplit({ ai: m.ai, flight: m.flight, yld: m.yld, liquid: m.liquid, target: m.target, total: m.total });

  // approvals: the single next step toward the vault's target, and how the owner signs it
  const a = s.exiting ? null : nextAction(m.books, m.target); // same thresholds as the live agent
  const el = $("approvals");
  if (a) {
    const actionArg = a.kind === "WithdrawAi" ? "WithdrawAi" : { [a.kind]: { amount: nearToYocto(a.amount) } };
    const gas = a.kind.endsWith("Ai") ? 450 : 150;
    const cmd = `near call ${L.id} step '${JSON.stringify({ action: actionArg })}' --accountId ${s.owner_id} --gas ${gas}000000000000`;
    const label = `${KIND_LABEL[a.kind] || a.kind}${a.amount ? `: ${fmtNear(a.amount)} NEAR` : ""}`;
    const owner = isOwner();
    el.innerHTML = `<div class="proposal"><div class="what">${label}</div>
      <div class="why">Next step toward the target of ${fmtNear(m.target)} NEAR on NEAR AI. ${m.report ? escapeHtml(m.report.reason) + "." : ""}</div>
      ${owner
        ? `<div>The agent takes this step on its next tick, or you can approve it now.</div>
           <div class="actions"><button class="button" id="approve-step" ${s.busy ? "disabled" : ""}>Approve in wallet</button><button class="link" id="show-cmd">or use the CLI</button></div>
           <pre id="cmd" hidden>${escapeHtml(cmd)}</pre>`
        : `<div>${App.account ? `Signed in as ${escapeHtml(App.account)}; only the owner, ${escapeHtml(s.owner_id)}, can approve.` : "The agent takes this step on its next tick. The owner can approve it now by connecting their wallet, or with:"}</div>
           <pre>${escapeHtml(cmd)}</pre>
           <div class="actions">${App.account ? "" : `<button class="button" id="owner-connect">Connect wallet</button>`}<button class="button ghost" id="copy-cmd">Copy command</button></div>`}
      </div>`;
    $("approve-step")?.addEventListener("click", () => act(`Approve: ${label}`, "step", { action: actionArg }, { gasTgas: gas, deposit: "0" }));
    $("show-cmd")?.addEventListener("click", () => { $("cmd").hidden = false; });
    $("owner-connect")?.addEventListener("click", openWallets);
    $("copy-cmd")?.addEventListener("click", () => navigator.clipboard?.writeText(cmd).then(() => { $("copy-cmd").textContent = "Copied"; }));
  } else {
    const unbonding = m.books.aiUnstaking + m.books.yieldUnstaking;
    el.innerHTML = unbonding > 0.01
      ? `<p class="empty">Nothing to approve yet. ${fmtNear(unbonding)} NEAR is unbonding ${m.books.yieldUnstaking > 0 ? "from yield" : "from NEAR AI"} (4 epochs); when it lands the agent ${m.target > m.ai ? "stakes it for NEAR AI" : "stakes it for yield"} toward the target of ${fmtNear(m.target)} NEAR.</p>`
      : `<p class="empty">The vault is on target. Nothing to approve.</p>`;
  }

  // history: what the chain keeps in state (events need an indexer; links go to the explorer)
  const ev = [];
  if (s.last_report) ev.push({ t: Number(s.last_target_ns) / 1e6, kind: "rebalance", detail: `${fmtNear(m.target)} NEAR (${s.last_report.reason}) · source ${s.last_report.source}` });
  ev.push({ t: Number(s.last_sync_ns) / 1e6, kind: "sync", detail: "balances re-read from the farm and the pool" });
  renderHistory(ev.sort((x, y) => y.t - x.t), e => { const d = new Date(e.t); return `${d.toLocaleString("en-US", { month: "short" })} ${d.getDate()}<br>${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; });
  $("hist-note").innerHTML = `<a href="${explorerUrl(L.id)}" target="_blank" rel="noopener">all events ↗</a>`;

  // forecast: credits over the next 14 days at the current stake and burn
  const slope = (m.c * m.ai - m.burn) / 24, pts = [];
  for (let k = 0; k <= 24 * 14; k += 6) pts.push([k, Math.max(0, m.credits + slope * k)]);
  const buf = s.policy.buffer_days * m.burn;
  chart($("chart-credits"), {
    xLabel: d => (d === 0 ? "now" : `+${d}d`), xMax: 24 * 14, yMax: niceMax(Math.max(buf * 2.2, ...pts.map(x => x[1]), 1e-6)), yFmt: fmtUsd, height: 150,
    lines: [{ name: "forecast", color: COLORS.ai, dash: "4 3", pts }], hlines: [{ y: buf, label: `buffer ${s.policy.buffer_days}d` }], playhead: 0,
    hover: t => `<b>in ${(t / 24).toFixed(1)} days</b><br>credits ${fmtUsd(Math.max(0, m.credits + slope * t))}`,
  });
  $("chart-credits").querySelector(".playhead")?.remove();
  $("fc-note").textContent = slope >= 0 ? "credits growing at this stake" : `at this stake, dry in ${(m.credits / (-slope * 24)).toFixed(1)} days`;
  for (const id of ["chart-usage", "chart-stake"]) { $(id).innerHTML = ""; $(id).previousElementSibling.hidden = true; }

  renderOwner(m, s);

  postView({
    ai: m.ai, yield: m.yld, crateNear: m.total / 20,
    flights: m.flight > 0.01 ? [{ amount: m.flight, dest: m.target > m.ai ? "ai" : "yield", progress: 0.5 }] : [],
    tank: m.credits / Math.max(1e-9, buf * 2), throttled: m.credits <= 0 && m.burn > 0, demand: 1,
  });
}

function renderOwner(m, s) {
  const owner = isOwner();
  $("owner").hidden = !owner;
  $("rails-save").hidden = !owner;
  renderWho();
  const hasBudget = budgetOnChain();
  if (!owner) return;
  if (!App.railsOpened) { App.railsOpened = true; document.querySelector("details.rails").open = true; }
  const dirty = policyDirty();
  $("save-policy").disabled = !dirty;
  if (!$("save-note").dataset.busy) $("save-note").textContent = dirty ? "unsaved changes" : hasBudget ? "budget and guard rails match the vault" : "guard rails match the vault · the budget is set in the agent's config until the vault upgrade";
  const ex = $("exit"), wd = $("withdraw");
  if (App.confirm !== "exit") { ex.textContent = s.exiting ? "Cancel exit" : "Exit: unwind both sides"; ex.classList.remove("confirm"); }
  const liquid = m.liquid;
  if (App.confirm !== "withdraw") { wd.textContent = `Withdraw ${fmtNear(liquid)} NEAR`; wd.classList.remove("confirm"); }
  wd.disabled = liquid < 0.01;
}

// ================================================================ helpers
function nearToYocto(v) {
  const [i, f = ""] = v.toFixed(6).split(".");
  return (BigInt(i) * 10n ** 24n + BigInt(f.padEnd(24, "0").slice(0, 24))).toString();
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}
let lastView = 0;
function postView(v) {
  const now = performance.now();
  if (now - lastView < 120) return;
  lastView = now;
  $("pic").contentWindow?.postMessage({ type: "ballast:view", ...v }, location.origin);
}

// login picture: a gently cycling vault
setInterval(() => {
  if (!$("login").hidden) {
    const t = Date.now() / 4000;
    $("login-pic").contentWindow?.postMessage({ type: "ballast:view", ai: 45000 + Math.sin(t) * 12000, yield: 55000 - Math.sin(t) * 12000, crateNear: 5000, tank: 0.5 + Math.sin(t) * 0.25, demand: 1, coin: Math.random() < 0.3, flights: [] }, location.origin);
  }
}, 400);

// restore the session on reload
const saved = session();
const q = new URLSearchParams(location.search);
// coming back from a browser wallet: a signed transaction, a cancelled one, or a sign-in
const pendingLabel = (() => { try { return sessionStorage.getItem("ballast:pending"); } catch { return null; } })();
if (q.has("transactionHashes") || q.has("errorCode")) {
  const hash = (q.get("transactionHashes") || "").split(",")[0];
  const label = pendingLabel || "Transaction";
  setTimeout(() => {
    $("owner-note").innerHTML = hash ? `${escapeHtml(label)}: sent · <a href="${txUrl(hash)}" target="_blank" rel="noopener">transaction ↗</a>` : `${escapeHtml(label)}: ${q.get("errorCode") === "userRejected" ? "you cancelled it in the wallet" : escapeHtml(q.get("errorMessage") || q.get("errorCode"))}`;
  }, 0);
  try { sessionStorage.removeItem("ballast:pending"); } catch { /* fine */ }
}
if (wallet.probablySignedIn()) {
  const n = saved?.mode === "live" && saved.id ? netFor(saved.id).id : wallet.signedInNetwork();
  if (n) wallet.setNetwork(n);
  wallet.accountId().then(acc => {
    if (!acc) return;
    App.account = acc;
    if (App.mode) { App.dirty = true; renderWho(); }
    else if (!saved) afterSignIn(acc);
  }).catch(() => {});
}
for (const k of ["transactionHashes", "errorCode", "errorMessage", "account_id", "all_keys", "public_key"]) q.delete(k);
history.replaceState(null, "", "app.html" + (q.toString() ? "?" + q : ""));
if (q.get("vault")) { $("vault-id").value = q.get("vault"); $("watch").requestSubmit(); }
else if (q.has("demo") || saved?.mode === "demo") enterDemo();
else if (saved?.mode === "live" && saved.id) { $("vault-id").value = saved.id; $("watch").requestSubmit(); }
