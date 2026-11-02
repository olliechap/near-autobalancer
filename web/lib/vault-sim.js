// A step-by-step version of the simulator in agent/src/sim.ts, for the game and the dashboard.
//
// sim.ts runs a whole 30 days in one call. Here the same vault advances one hour per tick(), so a page can
// animate it, let a player move stake by hand, or hold the agent's proposals until the owner approves them.
// With strategy "ballast" and autopilot on, it reproduces run(sc, "ballast") from sim.ts exactly
// (web/scripts/check-lib.mjs checks this).
import { plan, nextAction } from "./policy.js";
import { demandSeries } from "./sim.js";

export class VaultSim {
  /**
   * @param sc       a Scenario from defaultScenario()
   * @param opts.strategy  "ballast" (the agent), "manual" (a player moves stake), "static" or "all-ai"
   * @param opts.approve   when true, the agent proposes target changes and waits for approve()
   */
  constructor(sc, { strategy = "ballast", approve = false } = {}) {
    this.sc = sc;
    this.strategy = strategy;
    this.approveMode = approve;
    this.demand = demandSeries(sc);
    this.hour = 0;
    this.liquid = sc.vaultNear;
    this.ai = 0;
    this.yld = 0;
    this.aiOut = []; // tranches unbonding from the AI side: { amount, readyAt, dest }
    this.yldOut = [];
    this.credits = sc.startCreditsUsd;
    this.unmet = 0;
    this.throttled = 0;
    this.yieldEarned = 0;
    this.aiShareSum = 0;
    this.moves = 0;
    this.target = 0;
    this.hours = [];
    this.events = [];
    this.pending = null; // a proposal waiting for the owner: { t, target, reason, plan }
    this.unbondHours = sc.unbondEpochs * sc.epochHours;

    const c = sc.market.creditUsdPerNearDay;
    if (strategy === "all-ai") {
      this.ai = this.liquid;
      this.liquid = 0;
    } else if (strategy === "static" || strategy === "manual") {
      this.ai = Math.min(sc.budgetUsdWeek / 7 / c, sc.vaultNear * sc.params.maxAiShare);
      this.yld = sc.vaultNear - this.ai;
      this.liquid = 0;
    }
  }

  get done() {
    return this.hour >= this.sc.days * 24;
  }
  get inFlight() {
    return sum(this.aiOut) + sum(this.yldOut);
  }
  get total() {
    return this.liquid + this.ai + this.yld + this.inFlight;
  }
  get aiShare() {
    return this.ai / this.total;
  }
  get creditUsdPerNearDay() {
    return this.sc.market.creditUsdPerNearDay;
  }
  /** Days until credits run out at the current AI stake and the last 24 hours of usage. */
  get runwayDays() {
    const last = this.hours[this.hours.length - 1];
    return last ? last.runwayDays : 99;
  }

  recentDaily(h) {
    const days = [];
    for (let end = h; end > 0 && days.length < 14; end -= 24) {
      const start = Math.max(0, end - 24);
      let s = 0;
      for (let k = start; k < end; k++) s += this.demand[k];
      days.unshift((s * 24) / (end - start));
    }
    return days;
  }

  /** What the agent would decide right now. */
  plan(h = this.hour) {
    const daily = this.recentDaily(h);
    return plan(
      {
        totalNear: this.total,
        aiNear: this.ai,
        creditUsd: this.credits,
        dailyUsageUsd: daily.length ? daily : [this.sc.budgetUsdWeek / 7],
      },
      this.sc.market,
      { ...this.sc.params, burnFloorUsdDay: this.sc.budgetUsdWeek / 7 },
    );
  }

  books() {
    return {
      liquid: this.liquid,
      aiStaked: this.ai,
      aiUnstaking: sum(this.aiOut),
      aiWithdrawable: 0,
      yieldStaked: this.yld,
      yieldUnstaking: sum(this.yldOut),
      yieldCanWithdraw: false,
    };
  }

  setTarget(target, reason, h = this.hour) {
    this.events.push({ t: h, kind: "rebalance", detail: `target ${Math.round(target)} NEAR (${reason})`, target, reason });
    this.target = target;
    this.moves++;
  }

  /** The owner approves the pending proposal (approve mode). */
  approve() {
    if (!this.pending) return;
    const p = this.pending;
    this.pending = null;
    this.setTarget(p.target, p.reason + " · approved by owner");
    this.stepTowardTarget();
  }
  reject() {
    if (!this.pending) return;
    this.events.push({ t: this.hour, kind: "rejected", detail: `owner kept the target at ${Math.round(this.target)} NEAR` });
    this.pending = null;
  }

  /** One transaction at a time toward the target, as the live agent does with `step`. */
  stepTowardTarget() {
    for (let i = 0; i < 6; i++) {
      const a = nextAction(this.books(), this.target);
      if (!a || a.kind === "WithdrawAi" || a.kind === "WithdrawYield") break;
      this.apply(a);
    }
  }

  apply(a) {
    const h = this.hour;
    if (a.kind === "StakeAi") { this.liquid -= a.amount; this.ai += a.amount; }
    if (a.kind === "StakeYield") { this.liquid -= a.amount; this.yld += a.amount; }
    if (a.kind === "UnstakeAi") { this.ai -= a.amount; this.aiOut.push({ amount: a.amount, readyAt: h + this.unbondHours }); }
    if (a.kind === "UnstakeYield") { this.yld -= a.amount; this.yldOut.push({ amount: a.amount, readyAt: h + this.unbondHours }); }
    this.events.push({ t: h, kind: a.kind, detail: `${Math.round(a.amount)} NEAR`, amount: a.amount });
  }

  /** A player moves stake by hand: it unbonds, then lands staked on the other side. */
  move(from, amount) {
    if (from === "ai") {
      amount = Math.min(amount, this.ai);
      if (amount <= 0) return false;
      this.ai -= amount;
      this.aiOut.push({ amount, readyAt: this.hour + this.unbondHours, dest: "yield" });
      this.events.push({ t: this.hour, kind: "UnstakeAi", detail: `${Math.round(amount)} NEAR`, amount });
    } else {
      amount = Math.min(amount, this.yld);
      if (amount <= 0) return false;
      this.yld -= amount;
      this.yldOut.push({ amount, readyAt: this.hour + this.unbondHours, dest: "ai" });
      this.events.push({ t: this.hour, kind: "UnstakeYield", detail: `${Math.round(amount)} NEAR`, amount });
    }
    this.moves++;
    return true;
  }

  /** Advance one hour. Returns the hour's record. */
  tick() {
    const h = this.hour;
    const sc = this.sc;
    // Unbonded NEAR lands as liquid (or, for a player's move, staked on the other side).
    for (const q of [this.aiOut, this.yldOut]) {
      for (let i = q.length - 1; i >= 0; i--) {
        if (q[i].readyAt <= h) {
          const t = q.splice(i, 1)[0];
          if (t.dest === "ai") { this.ai += t.amount; this.events.push({ t: h, kind: "StakeAi", detail: `${Math.round(t.amount)} NEAR`, amount: t.amount }); }
          else if (t.dest === "yield") { this.yld += t.amount; this.events.push({ t: h, kind: "StakeYield", detail: `${Math.round(t.amount)} NEAR`, amount: t.amount }); }
          else this.liquid += t.amount;
        }
      }
    }

    if (this.strategy === "ballast" && h % sc.epochHours === 0) {
      const p = this.plan(h);
      if (p.move && Math.abs(p.targetAiNear - this.target) > 1e-6) {
        if (this.approveMode && h > 0) this.pending = { t: h, target: p.targetAiNear, reason: p.reason, plan: p };
        else this.setTarget(p.targetAiNear, p.reason, h);
      } else if (h === 0) this.target = this.ai;
      this.stepTowardTarget();
    }

    // Accrual: credits on the AI side, NEAR rewards on the yield side.
    const m = sc.market;
    const c = m.creditUsdPerNearDay;
    this.credits += (c * this.ai) / 24;
    const r = this.yld * ((m.apy * (1 - m.commission)) / (365 * 24));
    this.yld += r;
    this.yieldEarned += r;

    // Usage.
    const d = this.demand[h];
    const served = Math.min(d, this.credits);
    this.credits -= served;
    const throttled = d - served > 1e-9;
    if (throttled) {
      this.unmet += d - served;
      this.throttled++;
    }
    this.aiShareSum += this.ai / this.total;
    const net = d * 24 - c * this.ai;
    const rec = {
      t: h,
      demandUsd: d,
      servedUsd: served,
      creditsUsd: this.credits,
      aiNear: this.ai,
      yieldNear: this.yld,
      inFlightNear: this.inFlight,
      liquidNear: this.liquid,
      runwayDays: net <= 0 ? 99 : Math.min(99, this.credits / net),
      throttled,
    };
    this.hours.push(rec);
    this.hour++;
    return rec;
  }

  runToEnd() {
    while (!this.done) this.tick();
    return this.result();
  }

  result() {
    return {
      strategy: this.strategy,
      hours: this.hours,
      events: this.events,
      unmetUsd: this.unmet,
      throttledHours: this.throttled,
      yieldEarnedNear: this.yieldEarned,
      endCreditsUsd: this.credits,
      avgAiShare: this.aiShareSum / Math.max(1, this.hours.length),
      moves: this.moves,
    };
  }
}

function sum(q) {
  let s = 0;
  for (const x of q) s += x.amount;
  return s;
}
