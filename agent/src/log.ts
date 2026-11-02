// The agent's tick log (state/<vault>.log.jsonl) and the weekly digest built from it:
// "Covered $96 of $100 in usage; earned 2.1 NEAR; moved 1,800 NEAR toward AI on Tuesday after your usage spiked".
import fs from "node:fs";
import path from "node:path";
import { usd, nearAmt } from "./policy.ts";
import { explorer } from "./near.ts";

export interface LogAction {
  kind: string;
  tx: string;
  ok: boolean;
  [k: string]: any;
}

export interface LogEntry {
  t: number;
  totalNear: number;
  aiNear: number;
  yieldValueNear: number;
  yieldEarnedNear: number;
  creditUsd: number;
  spentUsd: number; // cumulative usage recorded by the meter
  earnedUsd: number; // cumulative credits earned (farm + packs)
  burnUsdDay: number;
  runwayDays: number | null;
  targetAiNear: number;
  actions: LogAction[];
}

const DIR = path.resolve(import.meta.dirname, "../state");
const file = (vault: string) => path.join(DIR, `${vault}.log.jsonl`);

export function appendLog(vault: string, e: LogEntry): void {
  fs.mkdirSync(DIR, { recursive: true });
  fs.appendFileSync(file(vault), JSON.stringify(e) + "\n");
}

export function readLog(vault: string): LogEntry[] {
  if (!fs.existsSync(file(vault))) return [];
  return fs.readFileSync(file(vault), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const day = (t: number) => new Date(t).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" });

/** Plain-language summary of the window ending at the last entry. Pure: takes the entries. */
export function digestOf(entries: LogEntry[], days: number, nearUsd: number): string {
  if (entries.length === 0) return "No agent activity logged yet.";
  const end = entries[entries.length - 1];
  const from = end.t - days * 86_400_000;
  const inWin = entries.filter((e) => e.t >= from);
  // Counters are cumulative, so the window is the last entry minus the last one before it (zero if none).
  const base = entries.filter((e) => e.t < from).pop();
  const unmet = (e?: LogEntry) => (e ? Math.max(0, e.spentUsd - e.earnedUsd) : 0);
  const usage = end.spentUsd - (base?.spentUsd ?? 0);
  const throttled = Math.max(0, unmet(end) - unmet(base));
  const covered = Math.max(0, usage - throttled);
  const earnedNear = end.yieldEarnedNear - (base?.yieldEarnedNear ?? 0);

  const lines: string[] = [];
  const pct = usage > 0 ? ` (${((covered / usage) * 100).toFixed(0)}%)` : "";
  lines.push(`Ballast, last ${days} days to ${day(end.t)}:`);
  lines.push(`Covered ${usd(covered)} of ${usd(usage)} in usage${pct}; earned ${earnedNear.toFixed(4)} NEAR (${usd(earnedNear * nearUsd)}) on the yield side.`);
  const moves = inWin.flatMap((e) => e.actions.filter((a) => a.ok && a.kind === "rebalance").map((a) => ({ ...a, t: e.t })));
  for (const m of moves) {
    const delta = m.toNear - m.fromNear;
    lines.push(
      `Moved ${nearAmt(Math.abs(delta))} NEAR toward ${delta > 0 ? "AI" : "yield"} (AI target ${nearAmt(m.fromNear)} → ${nearAmt(m.toNear)}) on ${day(m.t)}: ${m.reason}. ${explorer(m.tx)}`,
    );
  }
  const buys = inWin.flatMap((e) => e.actions.filter((a) => a.ok && a.kind === "BuyCredits").map((a) => ({ ...a, t: e.t })));
  for (const b of buys) lines.push(`Bought ${b.packs} emergency credit pack(s) for ${b.near} NEAR of earned yield on ${day(b.t)}. ${explorer(b.tx)}`);
  if (moves.length === 0 && buys.length === 0) lines.push("No moves needed: the split stayed inside its band.");
  const steps = inWin.reduce((a, e) => a + e.actions.filter((x) => x.ok && x.kind !== "rebalance" && x.kind !== "BuyCredits").length, 0);
  if (steps) lines.push(`${steps} on-chain step(s) carried those moves out.`);
  const runway = end.runwayDays == null ? "more than enough" : `${end.runwayDays.toFixed(1)} days`;
  lines.push(`Now: ${nearAmt(end.aiNear)} of ${nearAmt(end.totalNear)} NEAR earns credits; credits ${usd(end.creditUsd)}, runway ${runway}.`);
  return lines.join("\n");
}

export function digest(vault: string, days: number, nearUsd: number): string {
  return digestOf(readLog(vault), days, nearUsd);
}
