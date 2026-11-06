# Contributing to Ballast

Thanks for taking a look. Issues and pull requests are welcome.

## Layout

| Path | What it is |
|---|---|
| `contracts/vault` | The Ballast vault contract (Rust, near-sdk). Holds the owner's NEAR and splits stake between NEAR AI and a yield pool. |
| `contracts/pool` | A small staking pool used on testnet for both sides of a vault (the NEAR AI validator and the yield pool). |
| `agent/` | The off-chain agent (TypeScript on Node 22, no build step): policy, simulator and the loop that calls the vault. |
| `web/` | The static website: the landing game and the vault dashboard. See `web/README.md`. |
| `scripts/build.sh` | Builds the contract wasm files. |

## Running the checks

These are the same checks CI runs on every pull request.

```bash
# Contracts (Rust toolchain is pinned in rust-toolchain.toml)
cargo test
./scripts/build.sh

# Agent (Node >= 22.18)
cd agent
npm ci
npm test
node src/simulate.ts --out /tmp/sim.json
```

If you change `agent/src/policy.ts` or `agent/src/sim.ts`, regenerate the copies the website uses with
`node web/scripts/build-lib.mjs` (see `web/README.md`).

## Pull requests

- Keep each pull request to one change, and say what it changes and how you checked it.
- Add or update tests for contract and policy changes.
- Never commit keys, seed phrases, `.env` files or API tokens. The agent reads keys from
  `~/.near-credentials-ballast` (or `$BALLAST_CREDENTIALS`), outside the repo.

## License

By contributing you agree that your contributions are licensed under the MIT License in `LICENSE`.
