#![allow(unused_must_use)]
use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};
use std::collections::HashMap;

const NEAR: u128 = ONE_NEAR;

fn id(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn owner() -> AccountId {
    id("ollie.testnet")
}
fn vault_id() -> AccountId {
    id("vault.ollie.testnet")
}
fn stranger() -> AccountId {
    id("mallory.testnet")
}

fn policy() -> Policy {
    Policy {
        min_ai_bps: 1_000,
        max_ai_bps: 9_000,
        buffer_days: 7,
        cooldown_sec: U64(3_600),
        min_move: U128(NEAR),
        topup_cap: U128(2 * NEAR),
        budget_micro_usd_week: Some(U64(100_000_000)),
    }
}

/// `pred` calls with `deposit` attached; the vault holds `balance` NEAR at time `ts_sec`.
fn ctx(pred: AccountId, deposit: u128, balance_near: u128, ts_sec: u64) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(vault_id())
            .predecessor_account_id(pred.clone())
            .signer_account_id(pred)
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .account_balance(NearToken::from_yoctonear(balance_near * NEAR))
            .block_timestamp(ts_sec * 1_000_000_000)
            .storage_usage(0)
            .build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        HashMap::default(),
        vec![PromiseResult::Successful(vec![])]
    );
}

fn new_vault() -> Vault {
    ctx(owner(), 0, 101, 0);
    Vault::new(owner(), id("stake.ballast.testnet"), "prod_ai".into(), id("pool-ai.ballast.testnet"), id("pool-yield.ballast.testnet"), policy())
}

fn report() -> UsageReport {
    UsageReport {
        burn_micro_usd_per_day: U64(14_285_714),
        credit_balance_micro_usd: U64(50_000_000),
        source: "manual".into(),
        reason: "test".into(),
    }
}

/// The agent signs with a function-call key on the vault account, so the predecessor is the vault itself.
fn as_agent(balance: u128, ts: u64) {
    ctx(vault_id(), 0, balance, ts);
}

#[test]
fn liquid_excludes_reserve() {
    let v = new_vault();
    assert_eq!(v.get_state().liquid.0, 100 * NEAR);
    assert_eq!(v.get_state().total.0, 100 * NEAR);
}

#[test]
fn agent_sets_target_inside_band() {
    let mut v = new_vault();
    as_agent(101, 10);
    v.rebalance(U128(60 * NEAR), report(), None);
    let s = v.get_state();
    assert_eq!(s.target_ai.0, 60 * NEAR);
    assert_eq!(s.target_ai_bps, 6_000);
    assert!(s.last_report.is_some());
}

#[test]
#[should_panic(expected = "outside the policy band")]
fn target_above_max_share_rejected() {
    let mut v = new_vault();
    as_agent(101, 10);
    v.rebalance(U128(95 * NEAR), report(), None);
}

#[test]
#[should_panic(expected = "outside the policy band")]
fn target_below_min_share_rejected() {
    let mut v = new_vault();
    as_agent(101, 10);
    v.rebalance(U128(5 * NEAR), report(), None);
}

#[test]
#[should_panic(expected = "cooldown has not elapsed")]
fn cooldown_enforced() {
    let mut v = new_vault();
    as_agent(101, 10);
    v.rebalance(U128(60 * NEAR), report(), None);
    as_agent(101, 100);
    v.rebalance(U128(70 * NEAR), report(), None);
}

#[test]
fn cooldown_passes_after_wait() {
    let mut v = new_vault();
    as_agent(101, 10);
    v.rebalance(U128(60 * NEAR), report(), None);
    as_agent(101, 10 + 3_600);
    v.rebalance(U128(70 * NEAR), report(), None);
    assert_eq!(v.get_state().target_ai.0, 70 * NEAR);
}

#[test]
#[should_panic(expected = "below min_move")]
fn tiny_changes_rejected() {
    let mut v = new_vault();
    as_agent(101, 10);
    v.rebalance(U128(60 * NEAR), report(), None);
    as_agent(101, 10_000);
    v.rebalance(U128(60 * NEAR + NEAR / 2), report(), None);
}

#[test]
#[should_panic(expected = "agent only")]
fn stranger_cannot_rebalance() {
    let mut v = new_vault();
    ctx(stranger(), 0, 101, 10);
    v.rebalance(U128(60 * NEAR), report(), None);
}

#[test]
fn external_agent_account_can_rebalance() {
    let mut v = new_vault();
    ctx(owner(), 1, 101, 1);
    v.set_agent(Some(id("agent.testnet")));
    ctx(id("agent.testnet"), 0, 101, 10);
    v.rebalance(U128(60 * NEAR), report(), None);
    assert_eq!(v.get_state().target_ai.0, 60 * NEAR);
}

#[test]
#[should_panic(expected = "owner only")]
fn agent_cannot_withdraw() {
    let mut v = new_vault();
    ctx(vault_id(), 1, 101, 10);
    v.withdraw(None);
}

#[test]
#[should_panic(expected = "attach exactly 1 yoctoNEAR")]
fn owner_withdraw_needs_one_yocto() {
    let mut v = new_vault();
    ctx(owner(), 0, 101, 10);
    v.withdraw(None);
}

#[test]
fn owner_withdraws_liquid() {
    let mut v = new_vault();
    ctx(owner(), 1, 101, 10);
    v.withdraw(Some(U128(40 * NEAR)));
}

#[test]
#[should_panic(expected = "amount exceeds liquid balance")]
fn owner_cannot_withdraw_reserve() {
    let mut v = new_vault();
    ctx(owner(), 1, 101, 10);
    v.withdraw(Some(U128(101 * NEAR)));
}

#[test]
fn stake_ai_toward_target() {
    let mut v = new_vault();
    as_agent(101, 10);
    v.rebalance(U128(60 * NEAR), report(), Some(Action::StakeAi { amount: U128(60 * NEAR) }));
    assert!(v.get_state().busy);
}

#[test]
#[should_panic(expected = "would overshoot the AI target")]
fn stake_ai_overshoot_rejected() {
    let mut v = new_vault();
    as_agent(101, 10);
    v.rebalance(U128(60 * NEAR), report(), Some(Action::StakeAi { amount: U128(61 * NEAR) }));
}

#[test]
#[should_panic(expected = "vault is busy")]
fn one_action_at_a_time() {
    let mut v = new_vault();
    as_agent(101, 10);
    v.rebalance(U128(60 * NEAR), report(), Some(Action::StakeAi { amount: U128(30 * NEAR) }));
    v.step(Action::StakeAi { amount: U128(30 * NEAR) });
}

#[test]
#[should_panic(expected = "liquid NEAR is needed for the AI target")]
fn yield_cannot_take_ai_liquid() {
    let mut v = new_vault();
    as_agent(101, 10);
    v.rebalance(U128(60 * NEAR), report(), None);
    v.step(Action::StakeYield { amount: U128(41 * NEAR) });
}

#[test]
fn yield_takes_the_rest() {
    let mut v = new_vault();
    as_agent(101, 10);
    v.rebalance(U128(60 * NEAR), report(), None);
    v.step(Action::StakeYield { amount: U128(40 * NEAR) });
}

fn synced(v: &mut Vault, ai: u128, ai_unst: u128, yld: u128, yld_unst: u128) {
    v.busy = true;
    v.on_sync(
        Ok(Some(FarmPositionView { staked_near_amount: U128(ai * NEAR) })),
        Ok(PendingUnstakeView { total_pending_yocto: U128(ai_unst * NEAR), withdrawable_yocto: U128(0) }),
        Ok(PoolAccountView { staked_balance: U128(yld * NEAR), unstaked_balance: U128(yld_unst * NEAR), can_withdraw: true }),
    );
}

#[test]
fn sync_updates_books_and_releases_busy() {
    let mut v = new_vault();
    ctx(vault_id(), 0, 1, 10); // 100 NEAR moved out: 60 AI, 40 yield
    synced(&mut v, 60, 0, 40, 0);
    let s = v.get_state();
    assert!(!s.busy);
    assert_eq!(s.total.0, 100 * NEAR);
    assert_eq!(s.ai_bps, 6_000);
}

#[test]
fn failed_views_keep_old_books() {
    let mut v = new_vault();
    ctx(vault_id(), 0, 1, 10);
    synced(&mut v, 60, 0, 40, 0);
    v.busy = true;
    v.on_sync(Err(PromiseError::Failed), Err(PromiseError::Failed), Err(PromiseError::Failed));
    assert_eq!(v.get_state().ai_staked.0, 60 * NEAR);
    assert!(!v.get_state().busy);
}

#[test]
#[should_panic(expected = "would undershoot the AI target")]
fn unstake_ai_below_target_rejected() {
    let mut v = new_vault();
    as_agent(1, 10);
    synced(&mut v, 60, 0, 40, 0);
    v.rebalance(U128(50 * NEAR), report(), Some(Action::UnstakeAi { amount: U128(11 * NEAR) }));
}

#[test]
fn unstake_ai_to_target() {
    let mut v = new_vault();
    as_agent(1, 10);
    synced(&mut v, 60, 0, 40, 0);
    v.rebalance(U128(50 * NEAR), report(), Some(Action::UnstakeAi { amount: U128(10 * NEAR) }));
}

#[test]
fn unstake_yield_to_fund_ai() {
    let mut v = new_vault();
    as_agent(1, 10);
    synced(&mut v, 60, 0, 40, 0);
    v.rebalance(U128(70 * NEAR), report(), Some(Action::UnstakeYield { amount: U128(10 * NEAR) }));
}

#[test]
#[should_panic(expected = "would undershoot the yield target")]
fn unstake_yield_beyond_need_rejected() {
    let mut v = new_vault();
    as_agent(1, 10);
    synced(&mut v, 60, 0, 40, 0);
    v.rebalance(U128(70 * NEAR), report(), Some(Action::UnstakeYield { amount: U128(11 * NEAR) }));
}

#[test]
#[should_panic(expected = "agent or owner only")]
fn stranger_cannot_step_normally() {
    let mut v = new_vault();
    ctx(stranger(), 0, 1, 10);
    synced(&mut v, 60, 0, 40, 0);
    v.step(Action::UnstakeYield { amount: U128(1 * NEAR) });
}

#[test]
fn exit_lets_anyone_unwind() {
    let mut v = new_vault();
    ctx(owner(), 1, 1, 10);
    synced(&mut v, 60, 0, 40, 0);
    v.exit();
    ctx(stranger(), 0, 1, 11);
    v.step(Action::UnstakeAi { amount: U128(60 * NEAR) });
}

#[test]
#[should_panic(expected = "vault is exiting")]
fn exit_blocks_agent_targets() {
    let mut v = new_vault();
    ctx(owner(), 1, 101, 10);
    v.exit();
    as_agent(101, 11);
    v.rebalance(U128(60 * NEAR), report(), None);
}

#[test]
#[should_panic(expected = "vault is exiting")]
fn exit_blocks_new_stakes() {
    let mut v = new_vault();
    as_agent(101, 10);
    v.rebalance(U128(60 * NEAR), report(), None);
    ctx(owner(), 1, 101, 11);
    v.exit();
    as_agent(101, 12);
    v.step(Action::StakeAi { amount: U128(10 * NEAR) });
}

#[test]
#[should_panic(expected = "bad AI share bounds")]
fn bad_policy_rejected() {
    let mut v = new_vault();
    let mut p = policy();
    p.min_ai_bps = 9_500;
    ctx(owner(), 1, 101, 10);
    v.set_policy(p);
}

// ---------------------------------------------------------------- v2: top-ups and migration

fn buy(amount: u128) -> Action {
    Action::BuyCredits { price_id: "price_x".into(), quantity: U64(1), amount: U128(amount) }
}

/// Vault with 40 NEAR staked to yield (principal), now worth `worth` NEAR, and 10 NEAR liquid.
fn vault_with_yield(worth: u128) -> Vault {
    let mut v = new_vault();
    v.yield_net_in = (40 * NEAR) as i128;
    as_agent(11, 10);
    synced(&mut v, 50, 0, worth, 0);
    v
}

#[test]
fn earned_yield_counts_growth_only() {
    let v = vault_with_yield(43);
    assert_eq!(v.get_state().yield_earned.0, 3 * NEAR);
    // Cap is 2 NEAR per 30 days, earned is 3: the cap binds.
    assert_eq!(v.get_state().topup_available.0, 2 * NEAR);
}

#[test]
fn topup_within_cap_and_earnings() {
    let mut v = vault_with_yield(43);
    v.step(buy(NEAR));
}

#[test]
#[should_panic(expected = "top-up exceeds the cap or earned yield")]
fn topup_over_cap_rejected() {
    let mut v = vault_with_yield(43);
    v.step(buy(3 * NEAR));
}

#[test]
#[should_panic(expected = "top-up exceeds the cap or earned yield")]
fn topup_never_spends_principal() {
    let mut v = vault_with_yield(40); // nothing earned yet
    v.step(buy(NEAR / 10));
}

#[test]
fn topup_spend_accrues_and_window_resets() {
    let mut v = vault_with_yield(45);
    v.busy = true;
    v.on_action(buy(2 * NEAR)); // successful purchase (test promise result is Successful)
    v.busy = false;
    assert_eq!(v.get_state().topup_spent_window.0, 2 * NEAR);
    assert_eq!(v.get_state().topup_available.0, 0);
    as_agent(11, 10 + 31 * 24 * 3600);
    // New window: cap is back, and 3 of the 5 earned NEAR remain unspent.
    assert_eq!(v.get_state().topup_available.0, 2 * NEAR);
}

#[test]
#[should_panic(expected = "vault is exiting")]
fn no_topups_while_exiting() {
    let mut v = vault_with_yield(43);
    ctx(owner(), 1, 11, 10);
    v.exit();
    as_agent(11, 11);
    v.step(buy(NEAR));
}

#[test]
fn stake_and_withdraw_yield_move_principal() {
    let mut v = new_vault();
    ctx(vault_id(), 0, 101, 10);
    v.busy = true;
    v.on_action(Action::StakeYield { amount: U128(40 * NEAR) });
    assert_eq!(v.yield_net_in, (40 * NEAR) as i128);
    v.busy = true;
    v.on_action(Action::WithdrawYield { amount: U128(5 * NEAR) });
    assert_eq!(v.yield_net_in, (35 * NEAR) as i128);
}

#[test]
fn policy_json_without_budget_still_parses() {
    let p: Policy = near_sdk::serde_json::from_str(
        r#"{"min_ai_bps":0,"max_ai_bps":9000,"buffer_days":3,"cooldown_sec":"60","min_move":"0","topup_cap":"0"}"#,
    )
    .unwrap();
    assert!(p.budget_micro_usd_week.is_none());
}

#[test]
fn migrate_from_v1() {
    ctx(vault_id(), 0, 101, 10);
    let old = v1::Vault {
        owner_id: owner(),
        agent_id: None,
        staking_contract: id("stake.ballast.testnet"),
        ai_product_id: "prod_ai".into(),
        ai_validator_id: id("pool-ai.ballast.testnet"),
        yield_pool: id("pool-yield.ballast.testnet"),
        policy: v1::Policy { min_ai_bps: 0, max_ai_bps: 9000, buffer_days: 7, cooldown_sec: U64(60), min_move: U128(NEAR / 2), topup_cap: U128(0) },
        reserve: NEAR,
        ai_staked: 8 * NEAR,
        ai_unstaking: 0,
        ai_withdrawable: 0,
        yield_staked: 3 * NEAR,
        yield_unstaking: 0,
        yield_can_withdraw: true,
        target_ai: 8 * NEAR,
        last_target_ns: 5,
        last_sync_ns: 6,
        exiting: false,
        busy: false,
        last_report: Some(report()),
    };
    env::state_write(&old);
    let v = Vault::migrate();
    let s = v.get_state();
    assert_eq!(s.ai_staked.0, 8 * NEAR);
    assert_eq!(s.target_ai.0, 8 * NEAR);
    assert_eq!(s.policy.max_ai_bps, 9000);
    assert!(s.policy.budget_micro_usd_week.is_none());
    assert_eq!(s.yield_earned.0, 0, "existing yield is treated as principal");
    assert!(s.last_report.is_some());
}
