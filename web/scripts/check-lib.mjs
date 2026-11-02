// Checks that the browser's step-by-step VaultSim matches the agent's simulator hour for hour.
//   node web/scripts/check-lib.mjs
import assert from "node:assert/strict";
import { compare, defaultScenario } from "../lib/sim.js";
import { VaultSim } from "../lib/vault-sim.js";

const scenarios = [defaultScenario()];
for (const [spikeDay, spike, vault, seed] of [[3, 2, 60000, 1], [12, 3, 100000, 42], [0, 1, 20000, 9]]) {
  const sc = defaultScenario();
  Object.assign(sc, { spikeDay, spikeMultiplier: spike, vaultNear: vault, seed, spikeEndDay: 0 });
  scenarios.push(sc);
}
for (const sc of scenarios) {
  const results = compare(sc);
  for (const ref of results) {
    const got = new VaultSim(sc, { strategy: ref.strategy }).runToEnd();
    for (const k of ["unmetUsd", "throttledHours", "yieldEarnedNear", "endCreditsUsd", "avgAiShare", "moves"]) {
      assert.ok(Math.abs(got[k] - ref[k]) < 1e-6, `${ref.strategy} ${k}: ${got[k]} vs ${ref[k]}`);
    }
    for (let h = 0; h < ref.hours.length; h += 17) assert.ok(Math.abs(got.hours[h].creditsUsd - ref.hours[h].creditsUsd) < 1e-6);
  }
  const b = results[0];
  console.log(`ok  vault ${sc.vaultNear} spike x${sc.spikeMultiplier} from day ${sc.spikeDay}: ballast ${b.yieldEarnedNear.toFixed(1)} NEAR, ${b.throttledHours}h throttled`);
}
// Approve mode with every proposal approved straight away matches autopilot except for the first-hour target.
const sc = defaultScenario();
const s = new VaultSim(sc, { approve: true });
while (!s.done) { s.tick(); if (s.pending) s.approve(); }
console.log(`ok  approve-all: ${s.result().yieldEarnedNear.toFixed(1)} NEAR, ${s.result().throttledHours}h throttled`);
