// Parameter sweep behind the policy defaults: buffer days x trim threshold x churn band.
// Columns: bufferDays trimAboveBuffers churnShare unmet$ throttledHours yieldNEAR endCredits$ avgAiShare% moves
import { run, defaultScenario } from "../src/sim.ts";
for (const bd of [2,3,4,7]) for (const tr of [1.5,2]) for (const ch of [0.05,0.1]) {
  const sc = defaultScenario(); sc.params.bufferDays = bd; sc.params.trimAboveBuffers = tr; sc.params.churnShare=ch;
  const r = run(sc, "ballast");
  console.log(bd, tr, ch, r.unmetUsd.toFixed(2), r.throttledHours, r.yieldEarnedNear.toFixed(1), r.endCreditsUsd.toFixed(0), (r.avgAiShare*100).toFixed(1), r.moves);
}
