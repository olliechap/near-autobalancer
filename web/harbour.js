// Ballast harbour: the landing-page game, drawn with the Pixel Plays renderer (engine.js globals).
//
// Crates by the lighthouse are NEAR staked for NEAR AI: they fill the credit tank that keeps the light on.
// Crates on the barge are NEAR staked for yield: they earn NEAR. Ships are AI requests. Moving a crate takes
// 4 epochs on the ferry. The month runs on VaultSim, the same model as the agent's simulator, and at the end
// the player is compared with the Ballast agent on the same month.
//
// index.html?view=1 turns the page into a picture only: no HUD, no input, and the scene follows
// postMessage({ type: "ballast:view", ... }) from the dashboard.
import { defaultScenario } from "./lib/sim.js";
import { VaultSim } from "./lib/vault-sim.js";

const VIEW_ONLY = new URLSearchParams(location.search).has("view");
if (VIEW_ONLY) document.body.classList.add("view");

const CRATE = 5000; // NEAR per crate
const HOURS_PER_SEC = 9.6; // 30 days in 75 seconds
const PENALTY_PER_HOUR = 2; // score: NEAR earned minus 2 per throttled hour (your AI app is down)
const CARRY_Z = 1.9;

// ---------------------------------------------------------------- layout (world units)
const QUAY = { x0: -10.5, y0: 0.5, x1: -3.5, y1: 7, z: 0.7 };
const BARGE = { x0: 0.5, y0: -9, x1: 8, y1: -4.5, z: 0.55 };
const LIGHT = { x: -9.2, y: 1.8, top: 5.4 };
const TANK = { x: -4.6, y: 1.7, r: 0.7, h: 2.1 };
const FERRY_FROM = [-3.1, 4.2], FERRY_TO = [3.2, -4.1], FERRY_VIA = [2.6, 3.4];
const SHIP_FROM = [-1.9, 13.6], SHIP_TO = [13.6, -1.9]; // a lane across the front of the harbour

const STONE = [178, 170, 152], PLANK = [176, 132, 90], HULL = [92, 70, 58], WOOD = [204, 154, 92];
const TOWER = [240, 236, 226], BAND = [196, 72, 60], GLASS = [196, 210, 214], OIL = [246, 188, 56];
const SAIL = [244, 240, 228], SHIP_HULL = [66, 64, 80], COIN = [246, 202, 72], ROPE = [226, 218, 196];
const KEEPER = { shirt: [62, 82, 120], stripe: [236, 232, 220], legs: [44, 44, 58], hair: [92, 64, 52], skin: [214, 164, 128] };
const SAILOR = { shirt: [196, 72, 60], stripe: [196, 72, 60], legs: [52, 56, 70], hair: [222, 206, 160], skin: [196, 146, 112] };

const quaySlots = [], bargeSlots = [];
for (let layer = 0; layer < 2; layer++) {
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) quaySlots.push([-8.25 + c * 1.05, 3 + r * 1.05, QUAY.z + layer * 0.92]);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 6; c++) bargeSlots.push([1.4 + c * 1.05, -8.15 + r * 1.05, BARGE.z + layer * 0.92]);
}

// ---------------------------------------------------------------- water and bake
const waterX = new Float32Array(W * H), waterY = new Float32Array(W * H), shimmer = new Uint8Array(W * H);
const WATER = [[34, 70, 104], [48, 94, 132], [66, 120, 158], [96, 150, 182], [150, 196, 214]];
const waterRamp = WATER.map(c => rgb(...c));
function inWater(ix, iy) {
  const u = (ix - OX) / S, v = (iy - OY) / (S * SIN);
  const e = (u / 17) ** 2 + (v / 13.5) ** 2;
  return e + (noise(ix * 0.08, iy * 0.12) - 0.5) * 0.18 + (bayerAt(ix, iy) - 0.5) * 0.08 < 1;
}
function bake() {
  zb.fill(-1e9);
  pix.fill(rgb(255, 255, 255));
  for (let iy = 0; iy < H; iy++) for (let ix = 0; ix < W; ix++) {
    if (!inWater(ix, iy)) continue;
    const g = unproject(ix + 0.5, iy + 0.5), i = iy * W + ix;
    const tone = noise(g.x * 0.35, g.y * 0.35) * 1.4 + noise(g.x * 1.6, g.y * 0.6) * 0.6;
    pix[i] = waterRamp[clamp(Math.floor(0.9 + tone + (bayerAt(ix, iy) - 0.5) * 0.6), 0, 3)];
    ground[i] = 1;
    zb[i] = (g.x + g.y) / R2 * COS;
    waterX[i] = g.x; waterY[i] = g.y;
  }
  groundZ.set(zb);
  buildQuay();
  bakeOcclusion();
  staticShadow.set(shadowMask);
  applyShadows(groundZ);
  bakedPix.set(pix);
  bakedZ.set(zb);
}
function buildQuay() {
  // stone quay with a plank edge, posts and a coil of rope
  box(QUAY.x0, QUAY.y0, -0.6, QUAY.x1, QUAY.y1, QUAY.z, STONE, 1);
  box(QUAY.x1 - 0.35, QUAY.y0 + 2.6, -0.4, QUAY.x1 + 0.9, QUAY.y0 + 4.6, QUAY.z - 0.08, PLANK, 2);
  for (const [x, y] of [[QUAY.x1 + 0.75, QUAY.y0 + 2.75], [QUAY.x1 + 0.75, QUAY.y0 + 4.45]]) {
    box(x - 0.12, y - 0.12, -0.5, x + 0.12, y + 0.12, QUAY.z + 0.5, HULL, 3);
    for (let z = 0.2; z < QUAY.z + 0.5; z += 0.3) castShadow(x, y, z, 0.15, 1, 0);
  }
  for (let a = 0; a < 6.283; a += 0.1) for (const r of [0.22, 0.32, 0.42]) plot(-4.2 + Math.cos(a) * r, 6.3 + Math.sin(a) * r, QUAY.z + 0.06, rampOf(ROPE)[2 + (r > 0.3 ? 1 : 0)]);
  // the lighthouse: white tower, red bands, a gallery and a lantern room (the lamp is drawn live)
  const band = z => (Math.floor(z * 1.15) % 2 ? BAND : TOWER);
  capsule([LIGHT.x, LIGHT.y, QUAY.z], [LIGHT.x, LIGHT.y, LIGHT.top - 0.2], 0.95, 0.62, band, "solid");
  box(LIGHT.x - 0.95, LIGHT.y - 0.95, LIGHT.top - 0.25, LIGHT.x + 0.95, LIGHT.y + 0.95, LIGHT.top, [60, 58, 66], 4);
  for (let z = QUAY.z; z < LIGHT.top + 1.2; z += 0.35) castShadow(LIGHT.x, LIGHT.y, z, 0.85);
  // keeper's hut
  box(-10.2, 4.4, QUAY.z, -8.9, 6.6, QUAY.z + 1.5, [226, 214, 190], 5);
  box(-10.35, 4.25, QUAY.z + 1.5, -8.75, 6.75, QUAY.z + 1.72, BAND, 6);
  for (let x = -10.2; x <= -8.9; x += 0.5) for (let y = 4.4; y <= 6.6; y += 0.5) castShadow(x, y, QUAY.z + 1.2, 0.5);
}

// ---------------------------------------------------------------- live scene
const S_ = {
  time: 0, ships: [], coins: [], held: null, pointer: null, beam: 0, shipDebt: 0,
  view: { aiCrates: 9, yieldCrates: 11, flights: [], tank: 0.5, lampOn: true, throttled: false, demand: 1 },
};
function slotsFor(side) { return side === "ai" ? quaySlots : bargeSlots; }
function bob(t) { return STILL ? 0 : Math.round(Math.sin(t * 1.4) * 1.5) / 18; }

function drawCrate(x, y, z, seed, held) {
  const s = 0.42;
  box(x - s, y - s, z, x + s, y + s, z + 0.84, held ? [226, 178, 106] : WOOD, seed);
  // a darker strap across the lid
  for (let a = -s; a <= s; a += 0.045) plot(x + a, y, z + 0.85, rampOf(HULL)[2]);
  castShadow(x, y, z + 0.3, 0.55);
}
function cratePositions() {
  const out = [];
  const v = S_.view;
  const heldFrom = S_.held ? S_.held.from : null;
  const n = { ai: v.aiCrates - (heldFrom === "ai" ? 1 : 0), yield: v.yieldCrates - (heldFrom === "yield" ? 1 : 0) };
  const lift = bob(S_.time);
  for (const side of ["ai", "yield"]) {
    const slots = slotsFor(side);
    for (let k = 0; k < Math.min(n[side], slots.length); k++) {
      const [x, y, z] = slots[k];
      out.push({ side, x, y, z: z + (side === "yield" ? lift : 0), k });
    }
  }
  return out;
}
function drawBarge() {
  const lift = bob(S_.time);
  box(BARGE.x0, BARGE.y0, -0.3 + lift, BARGE.x1, BARGE.y1, BARGE.z - 0.1 + lift, HULL, 7);
  box(BARGE.x0 + 0.15, BARGE.y0 + 0.15, BARGE.z - 0.1 + lift, BARGE.x1 - 0.15, BARGE.y1 - 0.15, BARGE.z + lift, PLANK, 8);
  // a little wheelhouse at the stern
  box(BARGE.x1 - 1.1, BARGE.y1 - 1.9, BARGE.z + lift, BARGE.x1 - 0.25, BARGE.y1 - 0.3, BARGE.z + 1.3 + lift, [226, 214, 190], 9);
  box(BARGE.x1 - 1.2, BARGE.y1 - 2, BARGE.z + 1.3 + lift, BARGE.x1 - 0.15, BARGE.y1 - 0.2, BARGE.z + 1.45 + lift, [64, 108, 92], 10);
  for (let x = BARGE.x0; x <= BARGE.x1; x += 0.7) castShadow(x, BARGE.y0 + 2.2, 0.3, 1.2);
}
function ferryPoint(p) {
  const q = 1 - p;
  return [q * q * FERRY_FROM[0] + 2 * q * p * FERRY_VIA[0] + p * p * FERRY_TO[0], q * q * FERRY_FROM[1] + 2 * q * p * FERRY_VIA[1] + p * p * FERRY_TO[1]];
}
function drawFerries() {
  for (const f of S_.view.flights) {
    const p = clamp(f.dest === "yield" ? f.progress : 1 - f.progress, 0, 1);
    const [x, y] = ferryPoint(p);
    const lift = bob(S_.time + x);
    box(x - 0.85, y - 0.6, -0.15 + lift, x + 0.85, y + 0.6, 0.25 + lift, PLANK, 11);
    const n = Math.max(1, Math.min(4, f.crates));
    for (let k = 0; k < n; k++) drawCrate(x - 0.45 + (k % 2) * 0.9, y + (k < 2 ? 0 : 0) - 0 , 0.25 + lift + (k >= 2 ? 0.86 : 0), 20 + k, false);
    castShadow(x, y, 0.2, 0.9);
  }
}
function drawTank() {
  const v = S_.view, level = clamp(v.tank, 0, 1) * TANK.h;
  const oil = v.tank < 0.12 ? [214, 84, 60] : OIL;
  const step = 0.045;
  for (let t = 0; t < 6.283; t += 0.022) for (let z = 0; z <= TANK.h; z += step) {
    const nx = Math.cos(t), ny = Math.sin(t);
    const c = z <= level ? oil : GLASS;
    const shade = clamp(Math.round(2.6 - 0.5 * nx + 0.85 * ny) + (z > TANK.h - 0.08 ? 1 : 0), 0, 4);
    plot(TANK.x + nx * TANK.r, TANK.y + ny * TANK.r, QUAY.z + z, rampOf(c)[shade]);
  }
  for (let a = 0; a < 6.283; a += 0.06) for (let q = 0; q < TANK.r; q += step) plot(TANK.x + Math.cos(a) * q, TANK.y + Math.sin(a) * q, QUAY.z + TANK.h, rampOf(GLASS)[3]);
  // a pipe from the tank to the lighthouse
  for (let k = 0; k <= 1; k += 0.01) plot(lerp(TANK.x, LIGHT.x + 0.7, k), lerp(TANK.y, LIGHT.y, k), QUAY.z + 0.25, rampOf(HULL)[2]);
  castShadow(TANK.x, TANK.y, QUAY.z + 1, TANK.r);
}
function drawLamp() {
  const v = S_.view;
  const blink = Math.floor(S_.time * 2.5) % 2;
  const color = v.throttled ? (blink ? [214, 60, 52] : [70, 60, 70]) : v.lampOn ? [255, 226, 120] : [90, 86, 96];
  capsule([LIGHT.x, LIGHT.y, LIGHT.top + 0.2], [LIGHT.x, LIGHT.y, LIGHT.top + 0.85], 0.42, 0.42, () => color, "solid");
  // roof cap
  capsule([LIGHT.x, LIGHT.y, LIGHT.top + 1.15], [LIGHT.x, LIGHT.y, LIGHT.top + 1.5], 0.55, 0.1, () => [60, 58, 66], "solid");
}
function drawBeam() {
  const v = S_.view;
  if (!v.lampOn || v.throttled) return;
  const strength = clamp(0.35 + v.tank, 0.35, 1);
  const a0 = S_.beam;
  const ca = Math.cos(a0), sa = Math.sin(a0);
  for (let i = 0; i < pix.length; i++) {
    if (!ground[i] || zb[i] !== groundZ[i]) continue;
    const dx = waterX[i] - LIGHT.x, dy = waterY[i] - LIGHT.y;
    const along = dx * ca + dy * sa;
    if (along <= 1) continue;
    const across = Math.abs(-dx * sa + dy * ca) / along;
    if (across > 0.2) continue;
    const ix = i % W, iy = (i / W) | 0;
    const k = (1 - across / 0.2) * (1 - along / 22) * strength;
    if (k <= bayerAt(ix, iy) * 0.9) continue;
    const c = pix[i];
    pix[i] = rgb(lerp(c & 255, WARM[0], 0.55), lerp(c >> 8 & 255, WARM[1], 0.55), lerp(c >> 16 & 255, WARM[2], 0.4));
  }
}
function updateShimmer(windT) {
  for (let i = 0; i < pix.length; i++) {
    if (!ground[i]) continue;
    const ix = i % W, iy = (i / W) | 0;
    shimmer[i] = hash(ix + Math.floor(windT * 3) * 7, iy) > 0.985 || (noise(ix * 0.11 + windT * 0.6, iy * 0.45) > 0.78 && bayerAt(ix, iy) > 0.6) ? 1 : 0;
  }
}
let shimmerStamp = -1;
function drawWater(windT) {
  if (windT !== shimmerStamp) { shimmerStamp = windT; updateShimmer(windT); }
  for (let i = 0; i < pix.length; i++) if (shimmer[i] && zb[i] === groundZ[i]) pix[i] = waterRamp[4];
}

// ships: one per bit of usage, sailing past in the back; they queue when the light is out
function updateShips(dt) {
  const v = S_.view;
  S_.shipDebt += dt * 0.55 * v.demand;
  if (S_.shipDebt >= 1 && S_.ships.length < 9) {
    S_.shipDebt -= 1;
    S_.ships.push({ p: 0, lane: (Math.random() - 0.5) * 1.6, speed: 0.045 + Math.random() * 0.025, waiting: 0 });
  }
  S_.shipDebt = Math.min(S_.shipDebt, 1.5);
  for (const s of S_.ships) {
    const stop = v.throttled && s.p > 0.08 && s.p < 0.3;
    s.waiting = stop;
    if (!stop) s.p += s.speed * dt;
  }
  S_.ships = S_.ships.filter(s => s.p < 1);
}
function drawShips() {
  for (const s of S_.ships) {
    const x = lerp(SHIP_FROM[0], SHIP_TO[0], s.p) + s.lane, y = lerp(SHIP_FROM[1], SHIP_TO[1], s.p) + s.lane;
    const lift = bob(S_.time * 1.3 + s.p * 9);
    box(x - 0.55, y - 0.55, -0.1 + lift, x + 0.55, y + 0.55, 0.3 + lift, SHIP_HULL, 30);
    for (let z = 0.3; z < 1.9; z += 0.045) {
      const w = (1.9 - z) * 0.38;
      for (let a = 0; a <= w; a += 0.045) plot(x + 0.1 + a, y - a, z + lift, rampOf(s.waiting ? [214, 120, 110] : SAIL)[a > w - 0.05 ? 2 : 3]);
    }
    castShadow(x, y, 0.6, 0.55);
  }
}
function updateCoins(dt) {
  for (const c of S_.coins) { c.z += dt * 1.6; c.life -= dt; }
  S_.coins = S_.coins.filter(c => c.life > 0);
}
function spawnCoin() {
  if (S_.coins.length > 14) return;
  const k = Math.floor(Math.random() * Math.max(1, Math.min(S_.view.yieldCrates, bargeSlots.length)));
  const [x, y, z] = bargeSlots[k] || bargeSlots[0];
  S_.coins.push({ x, y, z: z + 1, life: 0.9 });
}
function drawCoins() {
  for (const c of S_.coins) sphere(c.x, c.y, c.z, 0.2, COIN, "gloss");
}

function draw() {
  pix.set(bakedPix);
  zb.set(bakedZ);
  pendingShadows.length = 0;
  const windT = STILL ? 0 : Math.floor(S_.time * WIND_FPS) / WIND_FPS;
  drawWater(windT);
  drawBarge();
  drawTank();
  drawLamp();
  const crates = cratePositions();
  for (const c of crates) drawCrate(c.x, c.y, c.z, c.k + (c.side === "ai" ? 40 : 80), false);
  S_.crates = crates;
  drawFerries();
  drawShips();
  drawCoins();
  figure(-6.6, 1.6, 0.6, { scale: 0.85, z: QUAY.z, armR: S_.view.throttled ? 2.7 : 0.1, armL: S_.view.throttled ? 2.6 : 0.08, stance: 0.1 }, KEEPER, dynamicAdd);
  figure(BARGE.x0 + 1, BARGE.y1 - 0.8, -0.9, { scale: 0.8, z: BARGE.z + bob(S_.time), armR: 0.2, armL: 0.1, stance: 0.12 }, SAILOR, dynamicAdd);
  if (S_.held) {
    const h = S_.held;
    drawCrate(h.x, h.y, CARRY_Z, 99, true);
  }
  flushShadows();
  applyShadows(groundZ);
  shadeEdges();
  drawBeam();
  if (S_.held) {
    const target = S_.held.from === "ai" ? project(4.2, -6.7, 2.6) : project(-6.7, 4.6, 2.6);
    drawArrow(target.sx, target.sy, S_.time);
  } else if (G.phase === "intro" && !VIEW_ONLY) {
    const c = S_.crates && S_.crates.find(c => c.side === "yield");
    if (c) { const p = project(c.x, c.y, c.z + 1.2); drawArrow(p.sx, p.sy, S_.time); }
  }
  ctx.putImageData(image, 0, 0);
}

// ---------------------------------------------------------------- the game
const G = { phase: "intro", sim: null, sc: null, clock: 0, agent: false, usedAgent: false, coinsShown: 0, wasThrottled: false, paused: false };
const nodes = {
  earned: document.getElementById("earned"), sub: document.getElementById("sub"), status: document.getElementById("status"),
  agent: document.getElementById("agent"), result: document.getElementById("result"), rows: document.getElementById("result-rows"),
  resultLine: document.getElementById("result-line"), resultTitle: document.getElementById("result-title"),
};
let statusText = "";
function setStatus(t) { if (t !== statusText) { statusText = t; nodes.status.textContent = t; } }

function newMonth() {
  const sc = defaultScenario();
  sc.seed = (Math.random() * 1e9) | 0;
  sc.spikeDay = 5 + Math.floor(Math.random() * 9);
  sc.spikeMultiplier = Math.round((1.6 + Math.random() * 0.8) * 10) / 10;
  sc.spikeEndDay = sc.spikeDay + 5 + Math.floor(Math.random() * 6);
  G.sc = sc;
  const sim = new VaultSim(sc, { strategy: "manual" });
  // start with the stated budget, rounded to whole crates
  const aiCrates = Math.round(sim.ai / CRATE);
  sim.ai = aiCrates * CRATE;
  sim.yld = sc.vaultNear - sim.ai;
  G.sim = sim;
  G.clock = 0;
  G.coinsShown = 0;
  G.usedAgent = G.agent;
  G.wasThrottled = false;
  if (G.agent) { sim.strategy = "ballast"; sim.target = sim.ai; }
  nodes.result.hidden = true;
  syncView();
  updateHud();
}
function start() {
  if (G.phase !== "intro") return;
  G.phase = "play";
  document.getElementById("pitch").hidden = true;
  document.getElementById("scores").hidden = false;
  sound("bell");
}
function setAgent(on) {
  G.agent = on;
  nodes.agent.setAttribute("aria-pressed", String(on));
  nodes.agent.textContent = on ? "agent is playing · take over" : "let the agent play";
  if (!G.sim) return;
  if (on) { G.usedAgent = true; G.sim.strategy = "ballast"; G.sim.target = G.sim.ai; start(); }
  else G.sim.strategy = "manual";
}
function syncView() {
  const s = G.sim, v = S_.view;
  if (!s) return;
  const last = s.hours[s.hours.length - 1];
  v.aiCrates = Math.round(s.ai / CRATE);
  v.yieldCrates = Math.round(s.yld / CRATE);
  const hourNow = s.hour + (G.clock % 1);
  v.flights = [...s.aiOut.map(t => ({ ...t, from: "ai" })), ...s.yldOut.map(t => ({ ...t, from: "yield" }))].map(t => ({
    crates: Math.max(1, Math.round(t.amount / CRATE)),
    dest: t.from === "ai" ? "yield" : "ai",
    progress: clamp(1 - (t.readyAt - hourNow) / s.unbondHours, 0, 1),
  }));
  const burnDay = s.sc.budgetUsdWeek / 7;
  v.tank = s.credits / (burnDay * 6);
  v.throttled = !!(last && last.throttled);
  v.lampOn = s.credits > 0.01 || !v.throttled;
  v.demand = last ? (last.demandUsd * 24) / burnDay : 1;
}
function updateHud() {
  const s = G.sim;
  const day = Math.min(s.sc.days, Math.floor(s.hour / 24) + 1);
  nodes.earned.textContent = s.yieldEarned.toFixed(1);
  nodes.sub.textContent = `day ${day} · credits $${s.credits.toFixed(0)} · ${s.throttled}h throttled`;
  nodes.sub.classList.toggle("alarm", S_.view.throttled);
}
function statusLine() {
  const s = G.sim;
  if (G.phase === "intro") return "drag a crate across to start · or let the agent play";
  if (G.paused) return "paused · space to carry on";
  if (S_.held) return S_.held.from === "ai" ? "drop it on the barge to earn NEAR" : "drop it by the lighthouse for AI credits";
  if (S_.view.throttled) return "the tank is dry: requests are throttled";
  const p = s.plan();
  if (p.runwayDays < 2) return `credits run out in ${p.runwayDays.toFixed(1)} days`;
  if (G.agent) return "the agent is balancing your vault";
  if (s.credits > (s.sc.budgetUsdWeek / 7) * 8) return "the tank is overflowing: that NEAR could be earning";
  return "keep the light on, and the barge busy";
}

function update(dt) {
  S_.time += dt;
  S_.beam += dt * (S_.view.throttled ? 0 : 1.15);
  updateShips(dt);
  updateCoins(dt);
  if (VIEW_ONLY) return;
  if (G.phase === "play" && !G.paused) {
    G.clock += dt * HOURS_PER_SEC;
    while (G.sim.hour < G.clock && !G.sim.done) G.sim.tick();
    const coins = Math.floor(G.sim.yieldEarned);
    while (G.coinsShown < coins) { G.coinsShown++; spawnCoin(); if (G.coinsShown % 5 === 0) sound("coin"); }
    syncView();
    if (S_.view.throttled && !G.wasThrottled) sound("horn");
    G.wasThrottled = S_.view.throttled;
    updateHud();
    if (G.sim.done) endMonth();
  } else syncView();
  if (G.phase !== "over") setStatus(statusLine());
}

function endMonth() {
  G.phase = "over";
  G.overAt = S_.time;
  if (S_.held) S_.held = null;
  const you = G.sim.result();
  const runs = [
    { name: G.usedAgent ? "you + agent" : "you", r: you, you: true },
    { name: "Ballast agent", r: new VaultSim(G.sc, { strategy: "ballast" }).runToEnd() },
    { name: "set and forget", r: new VaultSim(G.sc, { strategy: "static" }).runToEnd() },
    { name: "all in on AI", r: new VaultSim(G.sc, { strategy: "all-ai" }).runToEnd() },
  ];
  const score = r => r.yieldEarnedNear - PENALTY_PER_HOUR * r.throttledHours;
  nodes.rows.replaceChildren(...runs.map(({ name, r, you: me }) => {
    const tr = document.createElement("tr");
    if (me) tr.className = "you";
    for (const v of [name, r.yieldEarnedNear.toFixed(1), r.throttledHours + "h", score(r).toFixed(1)]) {
      const td = document.createElement("td");
      td.textContent = v;
      tr.append(td);
    }
    return tr;
  }));
  const agent = runs[1].r, beat = score(you) > score(agent) + 0.05;
  nodes.resultTitle.textContent = G.usedAgent ? "Month over, with the agent's help" : beat ? "You beat the agent" : "The agent wins this month";
  nodes.resultLine.textContent = beat
    ? `Nice. Now do that every week, for every epoch, forever. Usage spiked x${G.sc.spikeMultiplier} on day ${G.sc.spikeDay + 1}.`
    : `Usage spiked x${G.sc.spikeMultiplier} on day ${G.sc.spikeDay + 1}. The agent saw it coming and moved early, ${agent.throttledHours ? "and still" : "never"} ran dry${agent.throttledHours ? ` for ${agent.throttledHours}h` : ""}.`;
  nodes.result.hidden = false;
  setStatus("month over");
  sound(beat ? "bell" : "horn");
}

// ---------------------------------------------------------------- input
function toCanvas(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) * W / r.width, y: (e.clientY - r.top) * H / r.height };
}
function crateAt(px, py) {
  let best = null, bestD = 11;
  for (const c of S_.crates || []) {
    const p = project(c.x, c.y, c.z + 0.6);
    const d = Math.hypot(p.sx - px, p.sy - py);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}
function sideAt(px, py) {
  const a = project(-6.5, 4, 1), b = project(4.2, -6.7, 1);
  return Math.hypot(a.sx - px, a.sy - py) < Math.hypot(b.sx - px, b.sy - py) ? "ai" : "yield";
}
function pointerWorld() {
  const g = unproject(S_.pointer.x, S_.pointer.y + CARRY_Z * COS * S);
  return { x: clamp(g.x, -14, 14), y: clamp(g.y, -14, 14) };
}
function moveCrate(from) {
  if (G.phase === "over") return false;
  if (G.agent) setAgent(false);
  start();
  const amount = from === "ai" ? Math.min(CRATE, G.sim.ai) : Math.min(CRATE, G.sim.yld);
  if (amount < 1) return false;
  G.sim.move(from, amount);
  syncView();
  sound("drop");
  return true;
}
if (!VIEW_ONLY) {
  canvas.addEventListener("pointerdown", e => {
    ensureAudio();
    canvas.focus({ preventScroll: true });
    if (G.phase === "over") return;
    S_.pointer = toCanvas(e);
    const c = crateAt(S_.pointer.x, S_.pointer.y);
    if (!c) return;
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add("dragging");
    const w = pointerWorld();
    S_.held = { from: c.side, x: w.x, y: w.y };
    sound("pop");
  });
  canvas.addEventListener("pointermove", e => {
    if (!S_.held) return;
    S_.pointer = toCanvas(e);
    const w = pointerWorld();
    S_.held.x = w.x; S_.held.y = w.y;
  });
  const letGo = () => {
    canvas.classList.remove("dragging");
    const h = S_.held;
    if (!h) return;
    S_.held = null;
    const to = sideAt(S_.pointer.x, S_.pointer.y);
    if (to !== h.from) moveCrate(h.from);
    else sound("pop");
  };
  canvas.addEventListener("pointerup", letGo);
  canvas.addEventListener("pointercancel", () => { S_.held = null; canvas.classList.remove("dragging"); });
  addEventListener("keydown", e => {
    if (document.querySelector("dialog[open]")) return;
    const k = e.key.toLowerCase();
    if (k === "arrowleft") { e.preventDefault(); ensureAudio(); moveCrate("yield"); }
    else if (k === "arrowright") { e.preventDefault(); ensureAudio(); moveCrate("ai"); }
    else if (k === "a") { ensureAudio(); setAgent(!G.agent); }
    else if (k === " ") {
      e.preventDefault();
      ensureAudio();
      if (G.phase === "over") { if (S_.time - G.overAt > 0.5) again(); }
      else if (G.phase === "intro") start();
      else G.paused = !G.paused;
    }
  });
  nodes.agent.addEventListener("click", () => { ensureAudio(); setAgent(!G.agent); });
  const again = () => { G.phase = "intro"; newMonth(); if (G.agent) start(); };
  document.getElementById("again").addEventListener("click", again);
  const rules = document.getElementById("rules");
  for (const id of ["rules-open", "rules-open-2"]) document.getElementById(id).addEventListener("click", () => rules.showModal());
  rules.addEventListener("click", e => { if (e.target === rules) rules.close(); });
}

// dashboard picture mode
addEventListener("message", e => {
  if (e.origin !== location.origin || !e.data || e.data.type !== "ballast:view") return;
  const d = e.data;
  const v = S_.view;
  const crates = n => Math.max(0, Math.round(n));
  const scale = d.crateNear || CRATE;
  v.aiCrates = Math.min(quaySlots.length, crates(d.ai / scale));
  v.yieldCrates = Math.min(bargeSlots.length, crates(d.yield / scale));
  v.flights = (d.flights || []).map(f => ({ crates: Math.max(1, Math.round(f.amount / scale)), dest: f.dest, progress: f.progress }));
  v.tank = d.tank;
  v.throttled = !!d.throttled;
  v.lampOn = d.lampOn !== false;
  v.demand = d.demand == null ? 1 : d.demand;
  if (d.coin) spawnCoin();
});

// ---------------------------------------------------------------- sound
let audio = null, muted = false, noiseBuffer = null;
function ensureAudio() {
  if (audio) { if (audio.state === "suspended") audio.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  audio = new AC();
  noiseBuffer = audio.createBuffer(1, audio.sampleRate, audio.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
}
function burst(type, freq, volume, length) {
  const now = audio.currentTime, src = audio.createBufferSource(), filter = audio.createBiquadFilter(), gain = audio.createGain();
  src.buffer = noiseBuffer;
  filter.type = type; filter.frequency.value = freq; filter.Q.value = 0.7;
  gain.gain.setValueAtTime(volume, now);
  gain.gain.exponentialRampToValueAtTime(0.0005, now + length);
  src.connect(filter).connect(gain).connect(audio.destination);
  src.start(now, Math.random() * 0.5, length + 0.02);
}
function tone(freq, volume, length, type = "sine", delay = 0) {
  const now = audio.currentTime + delay, osc = audio.createOscillator(), gain = audio.createGain();
  osc.type = type; osc.frequency.value = freq;
  gain.gain.setValueAtTime(volume, now);
  gain.gain.exponentialRampToValueAtTime(0.0005, now + length);
  osc.connect(gain).connect(audio.destination);
  osc.start(now); osc.stop(now + length + 0.02);
}
function sound(kind) {
  if (!audio || muted || VIEW_ONLY) return;
  if (kind === "pop") burst("bandpass", 1300, 0.05, 0.06);
  if (kind === "drop") burst("lowpass", 420, 0.18, 0.16);
  if (kind === "coin") { tone(1320, 0.03, 0.12); tone(1760, 0.025, 0.16, "sine", 0.06); }
  if (kind === "horn") { tone(110, 0.08, 0.7, "sawtooth"); tone(116, 0.05, 0.7, "sawtooth"); }
  if (kind === "bell") { tone(660, 0.06, 1.1); tone(990, 0.03, 0.9); }
}
const muteButton = document.getElementById("mute");
muteButton?.addEventListener("click", () => {
  muted = !muted;
  muteButton.textContent = muted ? "sound off" : "sound on";
  muteButton.setAttribute("aria-pressed", String(muted));
});

// ---------------------------------------------------------------- boot
addEventListener("resize", fit);
fit();
bake();
newMonth();
let last = performance.now();
function frame(now) {
  update(Math.min(0.05, (now - last) / 1000));
  last = now;
  draw();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
window.__ballast = { G, S: S_, step(dt) { update(dt); draw(); }, moveCrate, setAgent, start };
