# Ballast

**Your NEAR pays for your AI, and never a token more than it needs to.**

NEAR AI lets you stake NEAR for inference: the staking rewards on that stake go to NEAR AI and come back as
non-transferable AI credits. Stake too much and you burn yield on credits you can't cash out. Stake too little and
your requests get throttled. Moving stake back out takes about 4 epochs, so nobody can tune this by hand.

Ballast is a non-custodial vault plus an agent. The vault holds your NEAR and splits it between NEAR AI's
stake-for-inference farm and an ordinary staking pool. The agent watches your usage, forecasts your burn, and moves
the split only when it drifts, inside limits you set on-chain. It can never send your NEAR anywhere else.

Status: MVP running on NEAR **testnet**. Built for the NEAR hackathon (Agent Economy track).

## Try it in three commands

Needs Rust 1.86 (pinned in `rust-toolchain.toml`) and Node 22.18 or later. No NEAR account needed for these.

```bash
cargo test                                   # 41 contract unit tests (vault + pool)
cd agent && npm install && npm test          # 15 policy, simulator and digest tests
node src/simulate.ts                         # 30 days of usage, three strategies, in under a second
```

What you should see from the simulator (100,000 NEAR vault, $100/week budget, usage doubles from day 10 to 20):

```
strategy   unmet usage  throttled h  NEAR yield earned  unused credits  avg AI share  moves
ballast          $0.00            0    110.6 ($276.62)         $104.24         65.9%      8
static         $120.67          116    198.9 ($497.34)           $3.45         43.4%      0
all-ai           $0.00            0        0.0 ($0.00)         $439.84        100.0%      0
```

* **static** stakes exactly the stated budget once and leaves it: it earns the most yield but is throttled for 116
  hours when usage spikes.
* **all-ai** stakes everything for AI: never throttled, earns no NEAR, and ends with $440 of credits it can't cash out.
* **ballast** is never throttled and still earns 110 NEAR of ordinary yield.

`node src/simulate.ts --realtime 60` replays the Ballast run hour by hour over 60 seconds, showing each agent move.
Flags: `--vault 60000 --budget 100 --spike-day 3 --spike 2 --spike-end 0 --near-usd 5 --days 30`.

## How it works

```
 owner ──deposit / set_policy / exit / withdraw──▶  vault.<you>.near  ◀──rebalance / step── agent (function-call key)
                                                     │            │
                         stake(product_id) ◀─────────┘            └────────▶ deposit_and_stake
                         unstake / withdraw                                   unstake / withdraw
                  NEAR AI staking-contract (farm)                         ordinary staking pool
                  rewards → AI credits                                    rewards → NEAR
```

* **Vault contract** (`contracts/vault`, Rust, near-sdk 5.26). One per user, on a sub-account they own. Stores the
  owner, the policy (min and max AI share, buffer days, cooldown, minimum move, top-up cap, weekly AI budget), the
  AI target, and the two contract ids. The agent sets a target and steps toward it one action at a time
  (`StakeAi`, `UnstakeAi`, `WithdrawAi`, `StakeYield`, `UnstakeYield`, `WithdrawYield`, and the emergency
  `BuyCredits`). Every check only lets funds move *toward* the
  target, so a bad agent can stall the vault but not drain or redirect it. After each action the vault re-reads its
  balances from the two contracts' own views (`sync`). Every move emits a NEP-297 event (`standard: "ballast"`).
* **Agent key.** The agent signs with a function-call access key on the vault account, limited to `rebalance`,
  `step` and `sync`. Function-call keys cannot attach deposits or call other methods, and `withdraw` sends only to
  the owner and needs 1 yoctoNEAR attached. On testnet we tried all three attacks; see "Trust" below.
* **Emergency top-up.** `BuyCredits` buys one-off credit packs through the staking contract's `pay`. The vault
  allows it only up to `topup_cap` per rolling 30 days and only out of yield it has earned (yield-side value above
  the NEAR moved in), so a top-up never spends principal.
* **Upgrades.** `migrate` moves a v1 vault's state to v2 in the same transaction as the code deploy
  (`agent/scripts/upgrade-vault.ts`); the testnet vault was upgraded in place.
* **Exit.** The owner calls `exit`. From then on the agent can't set targets and *anyone* may call `step` to
  unwind both sides, so nobody can block an exit. The owner then calls `withdraw`.
* **AI side.** NEAR AI's own `staking-contract` from
  [nearai/house-of-stake-contracts](https://github.com/nearai/house-of-stake-contracts) (release build at commit
  `056fb6e`, sha256-checked by the deploy script), with a Farm product at NEAR AI's published rate:
  `$100 NEAR x 1 month = $1 credit`.
* **Yield side, and the pool behind the AI farm.** `contracts/pool`: a small staking pool with the standard
  interface (`deposit_and_stake`, `unstake`, `withdraw`, `get_account`), a fixed APY and a configurable unbond.
* **Agent** (`agent/src/agent.ts`, TypeScript on Node). Each tick: sync, read the farm position, pending unstakes
  and pool balance, read the credit meter, run the policy, buy emergency credits if needed, then `rebalance` and
  `step`. The weekly budget comes from the vault's policy (`budget_micro_usd_week`), so the owner sets it on-chain.
  Each tick is logged to `agent/state/<vault>.log.jsonl`; `node src/agent.ts digest` turns it into the weekly
  digest ("Covered $X of $Y in usage; earned Z NEAR; moved N NEAR toward AI on Tuesday: ...").

### The policy (`agent/src/policy.ts`)

Credits per staked NEAR are a published constant: the farm's `reward_rate` (24-decimal reward units per second per
NEAR). At NEAR AI's rate that is **c = $0.000329 per NEAR per day**, whatever the NEAR price.

1. Forecast burn **b** ($/day): an exponentially weighted average of rolling 24-hour usage, never below
   the user's stated weekly budget, or 75% of the latest day.
2. Steady-state AI stake: **b / c**.
3. Buffer **B = buffer days × b** (default 3). If credits are below B, add stake to refill the gap over 7 days.
   If credits are above 2B, return the excess to yield (trims are slow to undo, so they need a full double buffer).
4. Clamp to the owner's min and max AI share. Report coverage honestly when the vault is too small.
5. Emergency: if runway is shorter than the time it takes to add stake (unbond + 1 day), buy just enough one-off
   packs to bridge that gap, within what the vault allows, as well as adding stake.
6. Don't churn: move only when the change exceeds 10% of the vault and the vault's `min_move`, except in an
   emergency.
7. Re-run every epoch.

The simulator picked the defaults: a 7-day buffer avoided throttling too, but parked about 10 points more of the
vault in credits (`node agent/scripts/sweep.ts` reruns the sweep).

## Live on testnet

The full stack is deployed under `ballast-11012319.testnet` (ids in `agent/deployments/testnet.json`):

| Account | What it is |
|---|---|
| `stake.ballast-11012319.testnet` | NEAR AI staking-contract, Farm product `prod_6TSXAT9FNIPqAs` |
| `pool-ai.ballast-11012319.testnet` | validator behind the farm (no APY: NEAR AI keeps the rewards) |
| `pool-yield.ballast-11012319.testnet` | yield pool, 4.5% APY, 1-epoch unbond |
| `vault.ballast-11012319.testnet` | demo vault, ~12 NEAR, agent key limited to rebalance / step / sync |
| `vault-exit.ballast-11012319.testnet` | second vault used to test a full exit |

Look at it without any keys:

```bash
cd agent
node src/agent.ts status        # reads the vault, the farm and the pool, prints the plan, sends nothing
```

Deploy your own copy (needs a funded testnet account; the deploy script sweeps any `ballast-fund*` faucet accounts
in your credentials folder into the root):

```bash
./scripts/build.sh
cd agent
BALLAST_ROOT=<you>.testnet node scripts/deploy-testnet.ts   # keys read from ~/.near-credentials-ballast/<account>.json
node src/agent.ts once                                       # one agent tick: sync, plan, rebalance, step
node src/agent.ts usage 0.01                                 # record a usage spike on the testnet credit meter
node src/agent.ts loop 600                                   # run the agent every 10 minutes
node src/agent.ts digest 7                                   # what the agent did this week, in plain words
node scripts/upgrade-vault.ts                                # upgrade a v1 vault to v2 and set up top-ups
node scripts/trust-demo.ts                                   # the three attacks below
node scripts/exit-demo.ts setup|exit|finish                  # full exit on a second vault
```

Testnet amounts are small, so the default testnet budget is `BUDGET_USD_WEEK=0.015`, which a 12 NEAR vault can
cover. Credits only exist on mainnet, so on testnet `agent/src/meter.ts` applies NEAR AI's formula: credits earned
are the farm's on-chain `total_earned_reward_units` × $1 per unit, and credits spent are the usage it records.

### What has been run on testnet

* **Vault on a contract sub-account stakes into NEAR AI's farm** (the concept's day-1 risk, testnet side):
  rebalance + `StakeAi` 7 NEAR, then `StakeYield` 4.5 NEAR; the farm position accrues reward units.
* **Agent moves yield to AI across an epoch**: forecast burn needed 9.3 NEAR on the AI side, so the agent set the
  target and sent `UnstakeYield` 1.843 NEAR. After the epoch it sent `WithdrawYield` 1.843 and `StakeAi` 1.707,
  taking the AI side from 7 to 8.707 NEAR; the remaining 0.6 NEAR gap is inside the churn band.
* **Trust**:
  * agent key calls `withdraw` → rejected by the protocol (`MethodNameMismatch`);
  * agent key sets the AI target to 99% → rejected by the vault (`outside the policy band 0..9000bps`);
  * a stranger calls `step` → rejected by the vault (`agent or owner only`).
* **Usage spike** (the demo moment): with the vault upgraded to v2 in place, we recorded a $0.01 spike on the
  meter (about 5 days of the testnet budget at once). Runway dropped to zero, the agent flagged an emergency, and
  it raised the AI target from 9.3 to 10.1 NEAR (90% of the vault, the policy cap) and started unstaking the
  yield side to fund it. The digest reports it as "Moved 0.801 NEAR toward AI (AI target 9.314 → 10.115) on
  Monday 2 Nov: runway 0.0d is shorter than the 2.0d it takes to add stake."
* **Full exit** on `vault-exit`: the owner called `exit`; a stranger account unstaked both sides; after the epoch
  the stranger withdrew 1.5 NEAR from NEAR AI's staking contract (`withdraw(validator_id)`) and 0.5 NEAR from the
  yield pool; the owner then withdrew 2.304 NEAR to their own account.

## Limits, said plainly

* Testnet only so far. The mainnet proof (a small stake into NEAR AI's real farm from a sub-account, with credits
  showing in the NEAR AI console) is still to do, and NEAR AI's docs say contract accounts can't yet bind to an
  organization. Plan B, if so: the owner's own account stakes and approves each move.
* The yield side is our test pool, not a live validator or liquid staking token. Swapping a LiNEAR position for
  instant top-ups is a stretch goal.
* Top-ups are paid only from yield earned since v2 tracking began, and the testnet vault's yield side is small,
  so on testnet the top-up has run in unit tests but not yet on-chain. On testnet, packs are a 0.001 NEAR one-off
  price on the farm product and the meter credits them at the NEAR price; on mainnet NEAR AI sells credits itself.
* The agent signs as the vault, so the gas it prepays (about 0.5 NEAR for a 450 Tgas staking call, charged up front
  at a pessimistic price and mostly refunded) leaves the vault's balance while the call runs. The agent keeps
  0.6 NEAR of headroom when staking (`GAS_HEADROOM_NEAR`), and a target's share is computed on a total that is
  briefly a little low, which errs toward a lower share.
* The agent's function-call key has a 1 NEAR gas allowance; the owner re-adds the key when it runs out.

## Repository

```
contracts/vault   vault contract + unit tests
contracts/pool    testnet staking pool + unit tests
agent/src         policy, simulator, live agent, testnet credit meter, NEAR helpers
agent/scripts     deploy, trust demo, exit demo, parameter sweep
agent/deployments testnet account ids
web/sim.json      simulator output for the web app
```

Built with near-sdk-rs, near-api-js, and NEAR AI's house-of-stake staking-contract (MIT/Apache-2.0). Code written
with AI assistance (Claude Code). License: MIT.
