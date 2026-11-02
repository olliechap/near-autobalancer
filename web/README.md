# Ballast website

A landing page you can play, and a dashboard in the same style. Plain HTML and JavaScript: no build step, no
dependencies, deploys as static files.

```bash
node web/serve.mjs            # then open http://127.0.0.1:5310/
```

## What's here

| Page | What it does |
|---|---|
| `index.html` | **Keep the light on.** A month of NEAR AI usage in 75 seconds. Crates of staked NEAR sit by the lighthouse (staked for NEAR AI: they fill the credit tank) or on the barge (staked for yield: they earn NEAR). Ships are AI requests. Drag crates across; each one spends 4 epochs on the ferry. At the end you see how the Ballast agent, set-and-forget and all-in-on-AI did with the same month. Keys: ← / → move a crate, A lets the agent play, space pauses. |
| `app.html` | **Log in, then the dashboard.** Two ways in: the demo vault (100,000 NEAR simulated in the browser), or any Ballast vault on NEAR testnet by account id (read-only `get_state` over RPC, no keys). |

The dashboard has the weekly AI budget (with the plan it implies and any coverage gap), autopilot or "ask me first",
the guard rails (max AI share, credit buffer), pending approvals, the stake split against the target, a credit
forecast, usage against credits earned, where the NEAR sits over time, the rebalance history, and the month three
ways. In demo mode you can play, pause and scrub through the month; changing a setting reruns the month as if it
had been set on day 1. In "ask me first" the month pauses whenever the agent wants to move stake.

On a testnet vault the approvals card shows the single next step the agent would take (the same `nextAction` the
agent runs) and the exact `near call ... step` command for the owner to sign. Wallet signing is not wired in yet.

## Same code as the agent

`lib/policy.js` and `lib/sim.js` are generated from `agent/src/policy.ts` and `agent/src/sim.ts` with Node's
built-in type stripping, so the site runs exactly the policy the live agent runs:

```bash
node web/scripts/build-lib.mjs   # regenerate after changing the agent's policy or simulator
node web/scripts/check-lib.mjs   # VaultSim (step by step) matches sim.ts hour for hour on four scenarios
```

`lib/vault-sim.js` is the step-by-step version of the simulator that the game and dashboard animate. It adds
player moves and held proposals, and reproduces `run(sc, strategy)` exactly when left alone.

## Credits

The pixel renderer in `engine.js` is from [Pixel Plays](https://github.com/amirmushichge/pixel-plays) by Amir
Mushich (MIT, see `THIRD_PARTY.md`), and the look follows it. The harbour scene, game and dashboard are ours.
