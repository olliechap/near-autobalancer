#!/usr/bin/env bash
# Build both contracts to wasm32 for the NEAR VM (MVP features only, like cargo-near does).
set -euo pipefail
cd "$(dirname "$0")/.."
RUSTFLAGS="-C target-cpu=mvp -C link-arg=-s" cargo build --target wasm32-unknown-unknown --release -p ballast-pool -p ballast-vault
OUT=target/wasm32-unknown-unknown/release
if command -v wasm-opt >/dev/null 2>&1; then
  for c in ballast_pool ballast_vault; do
    wasm-opt -Oz --signext-lowering --strip-debug --strip-producers "$OUT/$c.wasm" -o "$OUT/$c.wasm"
  done
fi
ls -l "$OUT"/ballast_*.wasm
