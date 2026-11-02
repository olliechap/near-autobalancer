// CLI: run 30 days of usage through Ballast and two baselines, print what happened, write JSON for the web app.
//
//   node src/simulate.ts                    # instant
//   node src/simulate.ts --realtime 60      # replay the Ballast run over 60 seconds
//   node src/simulate.ts --vault 60000 --budget 100 --spike-day 3 --spike 2
import fs from "node:fs";
import path from "node:path";
import { compare, defaultScenario, type Result } from "./sim.ts";
import { yieldUsdPerNearDay } from "./policy.ts";

const args = process.argv.slice(2);
const opt = (name: string, d?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : d;
};

const sc = defaultScenario();
sc.vaultNear = Number(opt("vault", String(sc.vaultNear)));
sc.budgetUsdWeek = Number(opt("budget", String(sc.budgetUsdWeek)));
sc.spikeDay = Number(opt("spike-day", String(sc.spikeDay)));
sc.spikeEndDay = Number(opt("spike-end", String(sc.spikeEndDay)));
sc.spikeMultiplier = Number(opt("spike", String(sc.spikeMultiplier)));
sc.market.nearUsd = Number(opt("near-usd", String(sc.market.nearUsd)));
sc.days = Number(opt("days", String(sc.days)));
const realtime = Number(opt("realtime", "0"));
const out = opt("out", path.resolve(import.meta.dirname, "../../web/sim.json"))!;

const results = compare(sc);
const [ballast] = results;

const bar = (v: number, max: number, w = 24) => "█".repeat(Math.round((Math.max(0, v) / max) * w)).padEnd(w, "·");
const usd = (v: number) => `$${v.toFixed(2)}`;
const k = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0));

function header() {
  const c = sc.market.creditUsdPerNearDay;
  console.log(`Ballast simulator: ${sc.days} days, ${k(sc.vaultNear)} NEAR vault, $${sc.budgetUsdWeek}/week stated budget`);
  console.log(
    `usage x${sc.spikeMultiplier} from day ${sc.spikeDay}${sc.spikeEndDay ? ` to day ${sc.spikeEndDay}` : ""}; ` +
      `NEAR $${sc.market.nearUsd}, APY ${(sc.market.apy * 100).toFixed(1)}%, epoch ${sc.epochHours}h, unbond ${sc.unbondEpochs} epochs`,
  );
  console.log(
    `credits: $${(c * 1000).toFixed(3)}/day per 1,000 NEAR staked for AI; yield forgone: $${(yieldUsdPerNearDay(sc.market) * 1000).toFixed(3)}/day per 1,000 NEAR\n`,
  );
}

async function replay(r: Result, seconds: number) {
  const maxAi = sc.vaultNear;
  const evByHour = new Map<number, string[]>();
  for (const e of r.events) {
    if (e.kind === "rebalance") evByHour.set(e.t, [...(evByHour.get(e.t) ?? []), e.detail]);
  }
  const stepMs = (seconds * 1000) / r.hours.length;
  console.log("day  hour  AI stake                    credits    runway  usage/h");
  for (const hr of r.hours) {
    const ev = evByHour.get(hr.t);
    if (hr.t % 6 === 0 || ev) {
      const runway = hr.runwayDays >= 99 ? "  ∞  " : `${hr.runwayDays.toFixed(1)}d`.padStart(5);
      const flag = hr.servedUsd + 1e-9 < hr.demandUsd ? " THROTTLED" : hr.runwayDays < 2 ? " low" : "";
      console.log(
        `${String(Math.floor(hr.t / 24)).padStart(3)}  ${String(hr.t % 24).padStart(4)}  ${bar(hr.aiNear, maxAi)} ${k(hr.aiNear).padStart(5)}  ${usd(hr.creditsUsd).padStart(8)}  ${runway}  ${usd(hr.demandUsd)}${flag}`,
      );
      for (const e of ev ?? []) console.log(`           ↳ agent: ${e}`);
    }
    if (stepMs > 0) await new Promise((res) => setTimeout(res, stepMs));
  }
  console.log("");
}

function summary() {
  const usdYield = (n: number) => n * sc.market.nearUsd;
  console.log("strategy   unmet usage  throttled h  NEAR yield earned  unused credits  avg AI share  moves");
  for (const r of results) {
    console.log(
      `${r.strategy.padEnd(9)}  ${usd(r.unmetUsd).padStart(11)}  ${String(r.throttledHours).padStart(11)}  ${(r.yieldEarnedNear.toFixed(1) + " (" + usd(usdYield(r.yieldEarnedNear)) + ")").padStart(17)}  ${usd(r.endCreditsUsd).padStart(14)}  ${(r.avgAiShare * 100).toFixed(1).padStart(11)}%  ${String(r.moves).padStart(5)}`,
    );
  }
  const st = results.find((r) => r.strategy === "static")!;
  const all = results.find((r) => r.strategy === "all-ai")!;
  console.log(
    `\nBallast vs set-and-forget: ${usd(st.unmetUsd - ballast.unmetUsd)} less throttled usage.` +
      ` Ballast vs all-in AI: ${(ballast.yieldEarnedNear - all.yieldEarnedNear).toFixed(1)} more NEAR earned.`,
  );
}

header();
if (realtime > 0) await replay(ballast, realtime);
else {
  console.log("Ballast agent moves:");
  for (const e of ballast.events.filter((e) => e.kind === "rebalance"))
    console.log(`  day ${(e.t / 24).toFixed(1).padStart(4)}  ${e.detail}`);
  console.log("");
}
summary();

fs.mkdirSync(path.dirname(out), { recursive: true });
const thin = (r: Result) => ({ ...r, hours: r.hours.filter((h) => h.t % 3 === 0) });
fs.writeFileSync(out, JSON.stringify({ scenario: sc, results: results.map(thin) }));
console.log(`\nwrote ${path.relative(process.cwd(), out)}`);
