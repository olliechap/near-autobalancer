//! Ballast vault: one per user, deployed on a sub-account the user owns.
//!
//! It holds the user's NEAR and splits it between two places:
//! * the **AI side**: NEAR AI's stake-for-inference farm (`staking-contract` from house-of-stake), where staking
//!   rewards become inference credits, via `stake(product_id)`, `unstake(product_id, amount)` and
//!   `withdraw(validator_id)`;
//! * the **yield side**: an ordinary staking pool (`deposit_and_stake`, `unstake`, `withdraw`).
//!
//! Roles:
//! * **owner**: deposits, sets the policy, sets the agent, exits and withdraws. Only the owner can take NEAR out.
//! * **agent**: either a function-call access key on this account limited to `rebalance` and `step`, or an
//!   external `agent_id` account. It can set the AI target inside the owner's policy band and move funds one
//!   step at a time toward that target. It can never send NEAR anywhere except the two configured contracts.
//! * **anyone**: can call `sync` (refresh balances from the two contracts), and `step` once the owner has
//!   called `exit`, so nobody can stall an exit.
//!
//! Every cross-contract action is followed by `sync`, so the vault's books always come from the contracts'
//! own views rather than from local arithmetic.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json};
use near_sdk::{
    env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue,
};

const BPS: u128 = 10_000;
const ONE_NEAR: u128 = 10u128.pow(24);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

/// The staking contract's settlement pipeline requires 300 Tgas of prepaid gas on entry.
const GAS_STAKING_PIPELINE: Gas = Gas::from_tgas(300);
const GAS_POOL_CALL: Gas = Gas::from_tgas(30);
const GAS_VIEW: Gas = Gas::from_tgas(10);
const GAS_ON_ACTION: Gas = Gas::from_tgas(70);
const GAS_ON_SYNC: Gas = Gas::from_tgas(15);

#[derive(Clone)]
#[near(serializers = [borsh, json])]
pub struct Policy {
    /// AI share bounds of the vault's total value, in basis points.
    pub min_ai_bps: u16,
    pub max_ai_bps: u16,
    /// Credit buffer the agent should keep, in days of forecast burn (enforced off-chain, recorded here).
    pub buffer_days: u16,
    /// Minimum seconds between target changes.
    pub cooldown_sec: U64,
    /// Smallest target change the agent may make, in yoctoNEAR (anti-churn).
    pub min_move: U128,
    /// Cap on one-off credit top-ups (`BuyCredits`) over any rolling 30 days, in yoctoNEAR. Top-ups are also
    /// limited to yield the vault has earned, so they never spend principal.
    pub topup_cap: U128,
    /// The owner's AI budget in micro-dollars per week; the agent reads it as the floor for its burn forecast.
    #[serde(default)]
    pub budget_micro_usd_week: Option<U64>,
}

#[derive(Clone)]
#[near(serializers = [borsh, json])]
pub struct UsageReport {
    /// Forecast burn, in micro-dollars per day.
    pub burn_micro_usd_per_day: U64,
    /// Credit balance the agent observed, in micro-dollars.
    pub credit_balance_micro_usd: U64,
    /// Where the burn figure came from: "manual", "nearai-usage-api", "simulator", ...
    pub source: String,
    /// Free-text reason shown in the event log.
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq)]
#[near(serializers = [borsh, json])]
pub enum Action {
    StakeAi { amount: U128 },
    UnstakeAi { amount: U128 },
    WithdrawAi,
    StakeYield { amount: U128 },
    UnstakeYield { amount: U128 },
    WithdrawYield { amount: U128 },
    /// Emergency top-up: buy one-off credits through the staking contract's `pay`. `amount` is the exact total
    /// (price x quantity) to attach.
    BuyCredits { price_id: String, quantity: U64, amount: U128 },
}

// --- shapes of the external views we read (only the fields we use) ---

#[near(serializers = [json])]
pub struct FarmPositionView {
    pub staked_near_amount: U128,
}

#[near(serializers = [json])]
pub struct PendingUnstakeView {
    pub total_pending_yocto: U128,
    pub withdrawable_yocto: U128,
}

#[near(serializers = [json])]
pub struct PoolAccountView {
    pub staked_balance: U128,
    pub unstaked_balance: U128,
    pub can_withdraw: bool,
}

#[near(serializers = [json])]
pub struct VaultView {
    pub owner_id: AccountId,
    pub agent_id: Option<AccountId>,
    pub staking_contract: AccountId,
    pub ai_product_id: String,
    pub ai_validator_id: AccountId,
    pub yield_pool: AccountId,
    pub policy: Policy,
    pub liquid: U128,
    pub ai_staked: U128,
    pub ai_unstaking: U128,
    pub ai_withdrawable: U128,
    pub yield_staked: U128,
    pub yield_unstaking: U128,
    pub yield_can_withdraw: bool,
    pub total: U128,
    pub ai_bps: u16,
    pub target_ai: U128,
    pub target_ai_bps: u16,
    pub last_target_ns: U64,
    pub last_sync_ns: U64,
    pub exiting: bool,
    pub busy: bool,
    pub last_report: Option<UsageReport>,
    /// NEAR the yield side has earned since the vault started tracking it (v2).
    pub yield_earned: U128,
    /// Top-ups spent in the current 30-day window, and what is still allowed now.
    pub topup_spent_window: U128,
    pub topup_available: U128,
}

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct Vault {
    owner_id: AccountId,
    agent_id: Option<AccountId>,
    staking_contract: AccountId,
    ai_product_id: String,
    ai_validator_id: AccountId,
    yield_pool: AccountId,
    policy: Policy,
    /// NEAR kept liquid on the account for gas and storage; never staked.
    reserve: u128,

    ai_staked: u128,
    ai_unstaking: u128,
    ai_withdrawable: u128,
    yield_staked: u128,
    yield_unstaking: u128,
    yield_can_withdraw: bool,

    target_ai: u128,
    last_target_ns: u64,
    last_sync_ns: u64,
    exiting: bool,
    busy: bool,
    last_report: Option<UsageReport>,

    // v2
    /// Net NEAR moved into the yield side (stakes minus withdrawals); value above this is earned yield.
    yield_net_in: i128,
    topup_window_start_ns: u64,
    topup_spent_window: u128,
    /// All top-ups ever paid; they may not exceed earned yield.
    topup_total: u128,
}

/// Upper bound on the per-gas price the runtime holds for prepaid gas (testnet: 450 Tgas held ~0.45 NEAR).
const PESSIMISTIC_GAS_PRICE_YOCTO: u128 = 1_000_000_000;

const TOPUP_WINDOW_NS: u64 = 30 * 24 * 3600 * 1_000_000_000;

#[near]
impl Vault {
    #[init]
    pub fn new(
        owner_id: AccountId,
        staking_contract: AccountId,
        ai_product_id: String,
        ai_validator_id: AccountId,
        yield_pool: AccountId,
        policy: Policy,
    ) -> Self {
        assert_policy(&policy);
        Self {
            owner_id,
            agent_id: None,
            staking_contract,
            ai_product_id,
            ai_validator_id,
            yield_pool,
            policy,
            reserve: ONE_NEAR,
            ai_staked: 0,
            ai_unstaking: 0,
            ai_withdrawable: 0,
            yield_staked: 0,
            yield_unstaking: 0,
            yield_can_withdraw: false,
            target_ai: 0,
            last_target_ns: 0,
            last_sync_ns: 0,
            exiting: false,
            busy: false,
            last_report: None,
            yield_net_in: 0,
            topup_window_start_ns: 0,
            topup_spent_window: 0,
            topup_total: 0,
        }
    }

    /// Upgrade a v1 vault's state in place (called by the owner's deploy transaction, on the vault account).
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let old: v1::Vault = env::state_read().expect("no v1 state");
        let yield_net_in = (old.yield_staked + old.yield_unstaking) as i128; // treat what is there now as principal
        Self {
            owner_id: old.owner_id,
            agent_id: old.agent_id,
            staking_contract: old.staking_contract,
            ai_product_id: old.ai_product_id,
            ai_validator_id: old.ai_validator_id,
            yield_pool: old.yield_pool,
            policy: Policy {
                min_ai_bps: old.policy.min_ai_bps,
                max_ai_bps: old.policy.max_ai_bps,
                buffer_days: old.policy.buffer_days,
                cooldown_sec: old.policy.cooldown_sec,
                min_move: old.policy.min_move,
                topup_cap: old.policy.topup_cap,
                budget_micro_usd_week: None,
            },
            reserve: old.reserve,
            ai_staked: old.ai_staked,
            ai_unstaking: old.ai_unstaking,
            ai_withdrawable: old.ai_withdrawable,
            yield_staked: old.yield_staked,
            yield_unstaking: old.yield_unstaking,
            yield_can_withdraw: old.yield_can_withdraw,
            target_ai: old.target_ai,
            last_target_ns: old.last_target_ns,
            last_sync_ns: old.last_sync_ns,
            exiting: old.exiting,
            busy: old.busy,
            last_report: old.last_report,
            yield_net_in,
            topup_window_start_ns: 0,
            topup_spent_window: 0,
            topup_total: 0,
        }
    }

    pub fn get_version(&self) -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }

    // ------------------------------------------------------------------ owner

    #[payable]
    pub fn deposit(&mut self) {
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "attach NEAR to deposit");
        emit("deposit", json!({ "from": env::predecessor_account_id(), "amount": U128(amount) }));
    }

    #[payable]
    pub fn set_policy(&mut self, policy: Policy) {
        self.assert_owner();
        assert_policy(&policy);
        self.policy = policy.clone();
        emit("set_policy", json!({ "policy": policy }));
    }

    #[payable]
    pub fn set_agent(&mut self, agent_id: Option<AccountId>) {
        self.assert_owner();
        self.agent_id = agent_id.clone();
        emit("set_agent", json!({ "agent_id": agent_id }));
    }

    #[payable]
    pub fn set_reserve(&mut self, reserve: U128) {
        self.assert_owner();
        require!(reserve.0 >= ONE_NEAR / 2, "reserve must be at least 0.5 NEAR");
        self.reserve = reserve.0;
    }

    /// Prepay storage on the staking contract (needed once before the first AI stake). Paid from the vault.
    #[payable]
    pub fn register_ai(&mut self, amount: U128) -> Promise {
        self.assert_owner();
        require!(amount.0 <= self.liquid(), "not enough liquid NEAR");
        ext::staking(self.staking_contract.clone(), NearToken::from_yoctonear(amount.0), GAS_POOL_CALL)
            .storage_deposit(Some(env::current_account_id()), Some(false))
    }

    /// Start a full exit: the target becomes 0 on both sides, the agent can no longer set targets, and anyone
    /// may call `step` to move funds back to liquid. The owner then calls `withdraw`.
    #[payable]
    pub fn exit(&mut self) {
        self.assert_owner();
        self.exiting = true;
        emit("exit", json!({ "total": U128(self.total()) }));
    }

    #[payable]
    pub fn cancel_exit(&mut self) {
        self.assert_owner();
        self.exiting = false;
        emit("cancel_exit", json!({}));
    }

    /// Send liquid NEAR to the owner. Requires 1 yoctoNEAR, which function-call keys cannot attach.
    #[payable]
    pub fn withdraw(&mut self, amount: Option<U128>) -> Promise {
        self.assert_owner();
        let liquid = self.liquid();
        let amount = amount.map(|a| a.0).unwrap_or(liquid);
        require!(amount > 0 && amount <= liquid, "amount exceeds liquid balance");
        emit("withdraw", json!({ "to": self.owner_id, "amount": U128(amount) }));
        Promise::new(self.owner_id.clone()).transfer(NearToken::from_yoctonear(amount))
    }

    /// Escape hatch if a callback ever runs out of gas and leaves the vault marked busy.
    #[payable]
    pub fn clear_busy(&mut self) {
        self.assert_owner();
        self.busy = false;
    }

    // ------------------------------------------------------------------ agent

    /// Set the AI-side target (yoctoNEAR) with the evidence behind it, and optionally take one step toward it.
    pub fn rebalance(
        &mut self,
        target_ai: U128,
        report: UsageReport,
        action: Option<Action>,
    ) -> PromiseOrValue<()> {
        self.assert_agent();
        require!(!self.exiting, "vault is exiting");
        let total = self.total_in_call();
        let target_bps = bps_of(target_ai.0, total);
        require!(
            target_bps >= self.policy.min_ai_bps && target_bps <= self.policy.max_ai_bps,
            format!(
                "target {}bps is outside the policy band {}..{}bps",
                target_bps, self.policy.min_ai_bps, self.policy.max_ai_bps
            )
        );
        if target_ai.0 != self.target_ai {
            let now = env::block_timestamp();
            let diff = target_ai.0.abs_diff(self.target_ai);
            require!(diff >= self.policy.min_move.0 || self.last_target_ns == 0, "change is below min_move");
            require!(
                self.last_target_ns == 0
                    || now.saturating_sub(self.last_target_ns) >= self.policy.cooldown_sec.0 * 1_000_000_000,
                "cooldown has not elapsed"
            );
            emit(
                "rebalance",
                json!({
                    "from_target_ai": U128(self.target_ai),
                    "to_target_ai": target_ai,
                    "target_ai_bps": target_bps,
                    "total": U128(total),
                    "report": report,
                }),
            );
            self.target_ai = target_ai.0;
            self.last_target_ns = now;
        }
        self.last_report = Some(report);
        match action {
            Some(a) => PromiseOrValue::Promise(self.internal_step(a)),
            None => PromiseOrValue::Value(()),
        }
    }

    /// Take one step toward the current target. Agent or owner; anyone while exiting.
    pub fn step(&mut self, action: Action) -> Promise {
        if !self.exiting {
            self.assert_agent_or_owner();
        }
        self.internal_step(action)
    }

    // ------------------------------------------------------------------ anyone

    /// Refresh balances from the staking contract and the yield pool.
    pub fn sync(&mut self) -> Promise {
        require!(!self.busy, "vault is busy");
        self.busy = true;
        self.sync_promise()
    }

    // ------------------------------------------------------------------ views

    pub fn get_state(&self) -> VaultView {
        let total = self.total();
        VaultView {
            owner_id: self.owner_id.clone(),
            agent_id: self.agent_id.clone(),
            staking_contract: self.staking_contract.clone(),
            ai_product_id: self.ai_product_id.clone(),
            ai_validator_id: self.ai_validator_id.clone(),
            yield_pool: self.yield_pool.clone(),
            policy: self.policy.clone(),
            liquid: U128(self.liquid()),
            ai_staked: U128(self.ai_staked),
            ai_unstaking: U128(self.ai_unstaking),
            ai_withdrawable: U128(self.ai_withdrawable),
            yield_staked: U128(self.yield_staked),
            yield_unstaking: U128(self.yield_unstaking),
            yield_can_withdraw: self.yield_can_withdraw,
            total: U128(total),
            ai_bps: bps_of(self.ai_staked, total),
            target_ai: U128(self.target_ai),
            target_ai_bps: bps_of(self.target_ai, total),
            last_target_ns: U64(self.last_target_ns),
            last_sync_ns: U64(self.last_sync_ns),
            exiting: self.exiting,
            busy: self.busy,
            last_report: self.last_report.clone(),
            yield_earned: U128(self.yield_earned()),
            topup_spent_window: U128(self.window_spent()),
            topup_available: U128(self.topup_available()),
        }
    }

    // ------------------------------------------------------------------ callbacks

    #[private]
    pub fn on_action(&mut self, action: Action) -> Promise {
        let ok = near_sdk::is_promise_success();
        if ok {
            match &action {
                Action::StakeYield { amount } => self.yield_net_in += amount.0 as i128,
                Action::WithdrawYield { amount } => self.yield_net_in -= amount.0 as i128,
                Action::BuyCredits { amount, .. } => {
                    self.roll_window();
                    self.topup_spent_window += amount.0;
                    self.topup_total += amount.0;
                }
                _ => {}
            }
        }
        emit(if ok { "step" } else { "step_failed" }, json!({ "action": action }));
        // Still busy: release happens in on_sync.
        self.sync_promise()
    }

    #[private]
    pub fn on_sync(
        &mut self,
        #[callback_result] farm: Result<Option<FarmPositionView>, PromiseError>,
        #[callback_result] pending: Result<PendingUnstakeView, PromiseError>,
        #[callback_result] pool: Result<PoolAccountView, PromiseError>,
    ) {
        self.busy = false;
        if let Ok(f) = farm {
            self.ai_staked = f.map(|f| f.staked_near_amount.0).unwrap_or(0);
        }
        if let Ok(p) = pending {
            self.ai_unstaking = p.total_pending_yocto.0;
            self.ai_withdrawable = p.withdrawable_yocto.0;
        }
        if let Ok(p) = pool {
            self.yield_staked = p.staked_balance.0;
            self.yield_unstaking = p.unstaked_balance.0;
            self.yield_can_withdraw = p.can_withdraw;
        }
        self.last_sync_ns = env::block_timestamp();
        emit(
            "sync",
            json!({
                "liquid": U128(self.liquid()),
                "ai_staked": U128(self.ai_staked),
                "ai_unstaking": U128(self.ai_unstaking),
                "yield_staked": U128(self.yield_staked),
                "yield_unstaking": U128(self.yield_unstaking),
            }),
        );
    }
}

impl Vault {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "owner only");
        require!(env::attached_deposit() == ONE_YOCTO, "attach exactly 1 yoctoNEAR");
    }

    fn is_agent(&self) -> bool {
        let p = env::predecessor_account_id();
        p == env::current_account_id() || Some(&p) == self.agent_id.as_ref()
    }

    fn assert_agent(&self) {
        require!(self.is_agent(), "agent only");
    }

    fn assert_agent_or_owner(&self) {
        require!(self.is_agent() || env::predecessor_account_id() == self.owner_id, "agent or owner only");
    }

    /// NEAR on the account that is free to stake or withdraw.
    fn liquid(&self) -> u128 {
        let storage = env::storage_byte_cost().as_yoctonear() * env::storage_usage() as u128;
        env::account_balance().as_yoctonear().saturating_sub(storage + self.reserve)
    }

    fn total(&self) -> u128 {
        self.liquid() + self.ai_staked + self.ai_unstaking + self.yield_staked + self.yield_unstaking
    }

    /// Liquid NEAR as seen from inside a call. When the agent signs with the vault's own function-call key, the
    /// runtime has already taken this call's prepaid gas from the balance, at a pessimistic gas price, and refunds
    /// the unused part afterwards. Count that held amount (bounded by half the reserve) as liquid, so the vault's
    /// checks see the balance it will have once the refund lands. Only for change calls: views cannot read the
    /// signer.
    fn liquid_in_call(&self) -> u128 {
        let float = if env::signer_account_id() == env::current_account_id() {
            (env::prepaid_gas().as_gas() as u128 * PESSIMISTIC_GAS_PRICE_YOCTO).min(self.reserve / 2)
        } else {
            0
        };
        self.liquid() + float
    }

    fn total_in_call(&self) -> u128 {
        self.liquid_in_call() + self.ai_staked + self.ai_unstaking + self.yield_staked + self.yield_unstaking
    }

    /// Yield earned since tracking began: current yield-side value above the net NEAR moved in.
    fn yield_earned(&self) -> u128 {
        let value = (self.yield_staked + self.yield_unstaking) as i128;
        (value - self.yield_net_in).max(0) as u128
    }

    fn window_spent(&self) -> u128 {
        if env::block_timestamp().saturating_sub(self.topup_window_start_ns) >= TOPUP_WINDOW_NS { 0 } else { self.topup_spent_window }
    }

    fn roll_window(&mut self) {
        if env::block_timestamp().saturating_sub(self.topup_window_start_ns) >= TOPUP_WINDOW_NS {
            self.topup_window_start_ns = env::block_timestamp();
            self.topup_spent_window = 0;
        }
    }

    /// What a top-up may spend now: inside the 30-day cap, and never more than unspent earned yield.
    fn topup_available(&self) -> u128 {
        let by_cap = self.policy.topup_cap.0.saturating_sub(self.window_spent());
        let by_yield = self.yield_earned().saturating_sub(self.topup_total);
        by_cap.min(by_yield)
    }

    fn desired_ai(&self) -> u128 {
        if self.exiting { 0 } else { self.target_ai }
    }

    /// Check an action against the target, then send it. Each check only lets funds move *toward* the target,
    /// so the agent can stall, but not drain or redirect, the vault.
    fn internal_step(&mut self, action: Action) -> Promise {
        require!(!self.busy, "vault is busy");
        let liquid = self.liquid_in_call();
        let desired_ai = self.desired_ai();
        let total = self.total_in_call();
        let desired_yield = if self.exiting { 0 } else { total.saturating_sub(desired_ai) };
        let action_for_cb = action.clone();
        let p = match action {
            Action::StakeAi { amount } => {
                require!(!self.exiting, "vault is exiting");
                require!(amount.0 >= ONE_NEAR, "stake at least 1 NEAR");
                require!(amount.0 <= liquid, "not enough liquid NEAR");
                require!(self.ai_staked + amount.0 <= desired_ai, "would overshoot the AI target");
                ext::staking(self.staking_contract.clone(), NearToken::from_yoctonear(amount.0), GAS_STAKING_PIPELINE)
                    .stake(self.ai_product_id.clone(), None)
            }
            Action::UnstakeAi { amount } => {
                require!(amount.0 > 0 && amount.0 <= self.ai_staked, "amount exceeds AI stake");
                require!(self.ai_staked - amount.0 >= desired_ai, "would undershoot the AI target");
                ext::staking(self.staking_contract.clone(), ONE_YOCTO, GAS_STAKING_PIPELINE)
                    .unstake(self.ai_product_id.clone(), Some(amount))
            }
            Action::WithdrawAi => {
                require!(self.ai_unstaking > 0, "nothing unstaking on the AI side");
                ext::staking(self.staking_contract.clone(), ONE_YOCTO, GAS_STAKING_PIPELINE)
                    .withdraw(self.ai_validator_id.clone())
            }
            Action::StakeYield { amount } => {
                require!(!self.exiting, "vault is exiting");
                require!(amount.0 > 0 && amount.0 <= liquid, "not enough liquid NEAR");
                // Keep any liquid NEAR the AI side still needs.
                let ai_gap = desired_ai.saturating_sub(self.ai_staked);
                require!(liquid - amount.0 >= ai_gap, "liquid NEAR is needed for the AI target");
                ext::pool(self.yield_pool.clone(), NearToken::from_yoctonear(amount.0), GAS_POOL_CALL)
                    .deposit_and_stake()
            }
            Action::UnstakeYield { amount } => {
                require!(amount.0 > 0 && amount.0 <= self.yield_staked, "amount exceeds yield stake");
                // desired_yield counts liquid NEAR too, so this only frees what the AI side cannot get from liquid.
                require!(self.yield_staked - amount.0 >= desired_yield, "would undershoot the yield target");
                ext::pool(self.yield_pool.clone(), NearToken::from_yoctonear(0), GAS_POOL_CALL).unstake(amount)
            }
            Action::WithdrawYield { amount } => {
                require!(amount.0 > 0 && amount.0 <= self.yield_unstaking, "amount exceeds unstaked yield");
                ext::pool(self.yield_pool.clone(), NearToken::from_yoctonear(0), GAS_POOL_CALL).withdraw(amount)
            }
            Action::BuyCredits { price_id, quantity, amount } => {
                require!(!self.exiting, "vault is exiting");
                require!(amount.0 > 0 && amount.0 <= liquid, "not enough liquid NEAR");
                require!(amount.0 <= self.topup_available(), "top-up exceeds the cap or earned yield");
                // The staking contract checks amount == price x quantity and refunds us if not.
                ext::staking(self.staking_contract.clone(), NearToken::from_yoctonear(amount.0), GAS_POOL_CALL)
                    .pay(Some(price_id), None, quantity)
            }
        };
        self.busy = true;
        p.then(ext::this().with_static_gas(GAS_ON_ACTION).on_action(action_for_cb))
    }

    fn sync_promise(&self) -> Promise {
        let me = env::current_account_id();
        ext::staking(self.staking_contract.clone(), NearToken::from_yoctonear(0), GAS_VIEW)
            .get_farm_position(me.clone(), self.ai_product_id.clone())
            .and(
                ext::staking(self.staking_contract.clone(), NearToken::from_yoctonear(0), GAS_VIEW)
                    .get_account_pending_unstake(me.clone(), self.ai_validator_id.clone()),
            )
            .and(ext::pool(self.yield_pool.clone(), NearToken::from_yoctonear(0), GAS_VIEW).get_account(me))
            .then(ext::this().with_static_gas(GAS_ON_SYNC).on_sync())
    }
}

fn assert_policy(p: &Policy) {
    require!(p.min_ai_bps <= p.max_ai_bps && p.max_ai_bps as u128 <= BPS, "bad AI share bounds");
}

fn bps_of(part: u128, total: u128) -> u16 {
    if total == 0 {
        return 0;
    }
    (part.saturating_mul(BPS) / total).min(BPS) as u16
}

fn emit(event: &str, data: serde_json::Value) {
    let ev = json!({ "standard": "ballast", "version": "1.0.0", "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{ev}"));
}

mod ext {
    use super::*;
    use near_sdk::ext_contract;

    #[allow(dead_code)]
    #[ext_contract(ext_staking)]
    pub trait Staking {
        fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>);
        fn stake(&mut self, product_id: String, price_id: Option<String>);
        fn unstake(&mut self, product_id: String, amount: Option<U128>);
        fn withdraw(&mut self, validator_id: AccountId);
        fn pay(&mut self, price_id: Option<String>, product_id: Option<String>, quantity: U64);
        fn get_farm_position(&self, account_id: AccountId, product_id: String);
        fn get_account_pending_unstake(&self, account_id: AccountId, validator_id: AccountId);
    }

    #[allow(dead_code)]
    #[ext_contract(ext_pool)]
    pub trait Pool {
        fn deposit_and_stake(&mut self);
        fn unstake(&mut self, amount: U128);
        fn withdraw(&mut self, amount: U128);
        fn get_account(&self, account_id: AccountId);
    }

    pub fn staking(id: AccountId, deposit: NearToken, gas: Gas) -> ext_staking::StakingExt {
        ext_staking::ext(id).with_attached_deposit(deposit).with_static_gas(gas)
    }

    pub fn pool(id: AccountId, deposit: NearToken, gas: Gas) -> ext_pool::PoolExt {
        ext_pool::ext(id).with_attached_deposit(deposit).with_static_gas(gas)
    }

    pub fn this() -> VaultExt {
        Vault::ext(env::current_account_id())
    }
}

/// The v1 state layout, kept only so `migrate` can read it.
mod v1 {
    use super::*;

    #[near(serializers = [borsh])]
    pub struct Policy {
        pub min_ai_bps: u16,
        pub max_ai_bps: u16,
        pub buffer_days: u16,
        pub cooldown_sec: U64,
        pub min_move: U128,
        pub topup_cap: U128,
    }

    #[near(serializers = [borsh])]
    pub struct Vault {
        pub owner_id: AccountId,
        pub agent_id: Option<AccountId>,
        pub staking_contract: AccountId,
        pub ai_product_id: String,
        pub ai_validator_id: AccountId,
        pub yield_pool: AccountId,
        pub policy: Policy,
        pub reserve: u128,
        pub ai_staked: u128,
        pub ai_unstaking: u128,
        pub ai_withdrawable: u128,
        pub yield_staked: u128,
        pub yield_unstaking: u128,
        pub yield_can_withdraw: bool,
        pub target_ai: u128,
        pub last_target_ns: u64,
        pub last_sync_ns: u64,
        pub exiting: bool,
        pub busy: bool,
        pub last_report: Option<UsageReport>,
    }
}

#[cfg(test)]
mod tests;
