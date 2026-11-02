//! Ballast testnet staking pool.
//!
//! A small stand-in for a NEAR core staking pool, used on testnet for both sides of a Ballast vault:
//!
//! * **AI side**: registered as the validator behind NEAR AI's `staking-contract` (house-of-stake), which
//!   calls `get_owner_id`, `deposit_and_stake`, `unstake`, `withdraw(amount)` and `get_account`.
//! * **Yield side**: the vault stakes into it directly, like any validator pool.
//!
//! Differences from a real pool, all deliberate for testnet:
//! * Rewards accrue continuously at a fixed `apy_bps` (paid from NEAR the owner pre-funds), instead of per epoch.
//! * The unbonding delay is `unlock_epochs` (real pools use 4), so tests can run with 0 or 1.
//! * No validator key, no shares, no commission.

use near_sdk::json_types::{U128, U64};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise};

const NS_PER_YEAR: u128 = 365 * 24 * 3600 * 1_000_000_000;
const BPS: u128 = 10_000;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Accounts,
}

#[derive(Clone, Default)]
#[near(serializers = [borsh, json])]
pub struct PoolAccount {
    pub staked: u128,
    pub unstaked: u128,
    pub unstaked_available_epoch_height: u64,
    pub last_accrual_ns: u64,
}

/// Same JSON shape as a NEAR core staking pool's `get_account`.
#[near(serializers = [json])]
pub struct HumanReadableAccount {
    pub account_id: AccountId,
    pub unstaked_balance: U128,
    pub staked_balance: U128,
    pub can_withdraw: bool,
}

#[near(serializers = [json])]
pub struct PoolInfo {
    pub owner_id: AccountId,
    pub unlock_epochs: u64,
    pub apy_bps: u32,
    pub total_staked: U128,
    pub epoch_height: U64,
}

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct Pool {
    owner_id: AccountId,
    unlock_epochs: u64,
    apy_bps: u32,
    total_staked: u128,
    accounts: LookupMap<AccountId, PoolAccount>,
}

#[near]
impl Pool {
    #[init]
    pub fn new(owner_id: AccountId, unlock_epochs: u64, apy_bps: u32) -> Self {
        require!(apy_bps <= 5_000, "apy_bps too high");
        Self { owner_id, unlock_epochs, apy_bps, total_staked: 0, accounts: LookupMap::new(StorageKey::Accounts) }
    }

    // ---- owner ----

    pub fn set_params(&mut self, unlock_epochs: u64, apy_bps: u32) {
        require!(env::predecessor_account_id() == self.owner_id, "owner only");
        require!(apy_bps <= 5_000, "apy_bps too high");
        self.unlock_epochs = unlock_epochs;
        self.apy_bps = apy_bps;
    }

    /// Owner tops up the reward reserve; any attached NEAR just sits in the pool balance.
    #[payable]
    pub fn fund_rewards(&mut self) {}

    // ---- staking-pool interface ----

    pub fn get_owner_id(&self) -> AccountId {
        self.owner_id.clone()
    }

    #[payable]
    pub fn deposit(&mut self) {
        let id = env::predecessor_account_id();
        let mut a = self.load(&id);
        a.unstaked += env::attached_deposit().as_yoctonear();
        self.save(&id, a);
    }

    #[payable]
    pub fn deposit_and_stake(&mut self) {
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "deposit_and_stake requires attached deposit");
        let id = env::predecessor_account_id();
        let mut a = self.load(&id);
        a.staked += amount;
        self.total_staked += amount;
        self.save(&id, a);
        log_event("deposit_and_stake", &id, amount);
    }

    pub fn stake(&mut self, amount: U128) {
        let id = env::predecessor_account_id();
        let mut a = self.load(&id);
        require!(amount.0 > 0 && amount.0 <= a.unstaked, "not enough unstaked balance");
        a.unstaked -= amount.0;
        a.staked += amount.0;
        self.total_staked += amount.0;
        self.save(&id, a);
    }

    /// `amount` is a yocto string, which also matches `NearToken`'s JSON form used by staking-contract.
    pub fn unstake(&mut self, amount: U128) {
        let id = env::predecessor_account_id();
        let mut a = self.load(&id);
        let take = amount.0.min(a.staked);
        require!(take > 0, "insufficient staked balance");
        self.do_unstake(&id, &mut a, take);
        self.save(&id, a);
    }

    pub fn unstake_all(&mut self) {
        let id = env::predecessor_account_id();
        let mut a = self.load(&id);
        let take = a.staked;
        require!(take > 0, "nothing staked");
        self.do_unstake(&id, &mut a, take);
        self.save(&id, a);
    }

    /// Returns the transfer promise so a caller's `.then` callback runs after the NEAR has arrived.
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        let id = env::predecessor_account_id();
        let mut a = self.load(&id);
        require!(self.can_withdraw(&a), "unstaked balance is not yet available");
        require!(amount.0 > 0 && amount.0 <= a.unstaked, "insufficient unstaked balance");
        a.unstaked -= amount.0;
        self.save(&id, a);
        log_event("withdraw", &id, amount.0);
        Promise::new(id).transfer(NearToken::from_yoctonear(amount.0))
    }

    pub fn withdraw_all(&mut self) -> Promise {
        let id = env::predecessor_account_id();
        let a = self.load(&id);
        let amount = a.unstaked;
        self.withdraw(U128(amount))
    }

    // ---- views ----

    pub fn get_account(&self, account_id: AccountId) -> HumanReadableAccount {
        let a = self.view(&account_id);
        HumanReadableAccount {
            can_withdraw: self.can_withdraw(&a),
            unstaked_balance: U128(a.unstaked),
            staked_balance: U128(a.staked),
            account_id,
        }
    }

    pub fn get_account_staked_balance(&self, account_id: AccountId) -> U128 {
        U128(self.view(&account_id).staked)
    }

    pub fn get_account_unstaked_balance(&self, account_id: AccountId) -> U128 {
        U128(self.view(&account_id).unstaked)
    }

    pub fn get_account_total_balance(&self, account_id: AccountId) -> U128 {
        let a = self.view(&account_id);
        U128(a.staked + a.unstaked)
    }

    pub fn is_account_unstaked_balance_available(&self, account_id: AccountId) -> bool {
        self.can_withdraw(&self.view(&account_id))
    }

    pub fn get_pool_info(&self) -> PoolInfo {
        PoolInfo {
            owner_id: self.owner_id.clone(),
            unlock_epochs: self.unlock_epochs,
            apy_bps: self.apy_bps,
            total_staked: U128(self.total_staked),
            epoch_height: U64(env::epoch_height()),
        }
    }
}

impl Pool {
    fn reward(&self, a: &PoolAccount) -> u128 {
        let now = env::block_timestamp();
        if a.staked == 0 || now <= a.last_accrual_ns || self.apy_bps == 0 {
            return 0;
        }
        let dt = (now - a.last_accrual_ns) as u128;
        // staked * apy * dt / year, ordered to avoid overflow for realistic balances (< 1e33 yocto).
        a.staked / BPS * self.apy_bps as u128 / NS_PER_YEAR * dt
            + (a.staked / BPS * self.apy_bps as u128 % NS_PER_YEAR) * dt / NS_PER_YEAR
    }

    /// Account with rewards accrued up to now (view-only, nothing written).
    fn view(&self, id: &AccountId) -> PoolAccount {
        let mut a = self.accounts.get(id).cloned().unwrap_or_default();
        a.staked += self.reward(&a);
        a.last_accrual_ns = env::block_timestamp();
        a
    }

    fn load(&mut self, id: &AccountId) -> PoolAccount {
        let before = self.accounts.get(id).map(|a| a.staked).unwrap_or(0);
        let a = self.view(id);
        self.total_staked += a.staked - before;
        a
    }

    fn save(&mut self, id: &AccountId, a: PoolAccount) {
        if a.staked == 0 && a.unstaked == 0 {
            self.accounts.remove(id);
        } else {
            self.accounts.insert(id.clone(), a);
        }
    }

    fn do_unstake(&mut self, id: &AccountId, a: &mut PoolAccount, take: u128) {
        a.staked -= take;
        a.unstaked += take;
        a.unstaked_available_epoch_height = env::epoch_height() + self.unlock_epochs;
        self.total_staked -= take;
        log_event("unstake", id, take);
    }

    fn can_withdraw(&self, a: &PoolAccount) -> bool {
        a.unstaked_available_epoch_height <= env::epoch_height()
    }
}

fn log_event(event: &str, account_id: &AccountId, amount: u128) {
    env::log_str(&format!(
        "EVENT_JSON:{{\"standard\":\"ballast-pool\",\"version\":\"1.0.0\",\"event\":\"{event}\",\"data\":[{{\"account_id\":\"{account_id}\",\"amount\":\"{amount}\"}}]}}"
    ));
}

#[cfg(test)]
#[allow(unused_must_use)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    const NEAR: u128 = 10u128.pow(24);

    fn ctx(pred: usize, deposit: u128, ts: u64, epoch: u64) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(accounts(pred))
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .block_timestamp(ts)
            .epoch_height(epoch)
            .build());
    }

    #[test]
    fn stake_unstake_withdraw_with_delay() {
        ctx(0, 0, 0, 10);
        let mut p = Pool::new(accounts(0), 2, 0);
        ctx(1, 5 * NEAR, 1, 10);
        p.deposit_and_stake();
        p.unstake(U128(2 * NEAR));
        let a = p.get_account(accounts(1));
        assert_eq!(a.staked_balance.0, 3 * NEAR);
        assert_eq!(a.unstaked_balance.0, 2 * NEAR);
        assert!(!a.can_withdraw);
        ctx(1, 0, 2, 12);
        assert!(p.get_account(accounts(1)).can_withdraw);
        p.withdraw(U128(2 * NEAR));
        assert_eq!(p.get_account(accounts(1)).unstaked_balance.0, 0);
    }

    #[test]
    fn rewards_accrue_at_apy() {
        ctx(0, 0, 0, 1);
        let mut p = Pool::new(accounts(0), 0, 500); // 5%
        ctx(1, 1000 * NEAR, 0, 1);
        p.deposit_and_stake();
        ctx(1, 0, NS_PER_YEAR as u64, 1);
        let staked = p.get_account(accounts(1)).staked_balance.0;
        assert!((staked as i128 - 1050 * NEAR as i128).abs() < NEAR as i128 / 1000, "{staked}");
    }

    #[test]
    #[should_panic(expected = "not yet available")]
    fn early_withdraw_fails() {
        ctx(0, 0, 0, 1);
        let mut p = Pool::new(accounts(0), 4, 0);
        ctx(1, NEAR, 0, 1);
        p.deposit_and_stake();
        p.unstake_all();
        ctx(1, 0, 0, 4);
        p.withdraw_all();
    }
}
