// Testnet credit meter. Credits only exist on mainnet, so on testnet this applies NEAR AI's own formula:
//   credits earned = farm reward units earned on-chain (staking-contract view) x $ per reward unit
//   credits spent  = usage recorded here (the stated weekly budget accrued over time, plus any usage events)
// On mainnet the same numbers come from NEAR AI's usage API (GET /v1/organizations/{org}/usage/balance).
import fs from "node:fs";
import path from "node:path";

interface Ev {
  t: number; // ms
  usd: number;
  note: string;
}
interface State {
  startedAt: number;
  lastAccrual: number;
  events: Ev[];
}

const DIR = path.resolve(import.meta.dirname, "../state");

export class Meter {
  readonly source = "testnet-meter";
  private file: string;
  private s: State;
  private budgetUsdWeek: number;
  private now: () => number;

  constructor(vault: string, budgetUsdWeek: number, now = () => Date.now()) {
    this.budgetUsdWeek = budgetUsdWeek;
    this.now = now;
    this.file = path.join(DIR, `${vault}.json`);
    const t = this.now();
    this.s = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, "utf8"))
      : { startedAt: t, lastAccrual: t, events: [] };
  }

  private save() {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.s, null, 1));
  }

  record(usd: number, note: string) {
    this.s.events.push({ t: this.now(), usd, note });
    this.save();
  }

  /** Book the stated budget as usage for the time since the last tick. */
  accrueBudget() {
    const t = this.now();
    const days = (t - this.s.lastAccrual) / 86_400_000;
    if (days > 0) this.s.events.push({ t, usd: (this.budgetUsdWeek / 7) * days, note: "budget" });
    this.s.lastAccrual = t;
    this.save();
  }

  spent(): number {
    return this.s.events.reduce((a, e) => a + e.usd, 0);
  }

  /** Credits earned on-chain (farm reward units) plus one-off packs bought, minus usage. */
  balance(earnedUnits: bigint, usdPerUnit: number, purchasedUsd = 0): number {
    return Math.max(0, this.earnedUsd(earnedUnits, usdPerUnit, purchasedUsd) - this.spent());
  }

  earnedUsd(earnedUnits: bigint, usdPerUnit: number, purchasedUsd = 0): number {
    return (Number(earnedUnits) / 1e24) * usdPerUnit + purchasedUsd;
  }

  /** Rolling 24h usage windows ending now, oldest first, scaled to $/day for a partial first window. */
  dailyUsage(): number[] {
    const t = this.now();
    const out: number[] = [];
    for (let end = t; end > this.s.startedAt && out.length < 14; end -= 86_400_000) {
      const start = Math.max(this.s.startedAt, end - 86_400_000);
      const sum = this.s.events.filter((e) => e.t > start && e.t <= end).reduce((a, e) => a + e.usd, 0);
      out.unshift((sum * 86_400_000) / Math.max(end - start, 3_600_000));
    }
    return out;
  }
}
