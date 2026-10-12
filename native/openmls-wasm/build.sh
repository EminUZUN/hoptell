#!/bin/sh
# Build the binding bundle hoptell ships in lib/mls/binding/ (amendment A11): the production WASM
# (no test features) and its glue in the form the loader evaluates. Runs inside the build image
# (Dockerfile, build-image.sh), offline: the image already holds the toolchain, wasm-bindgen-cli and
# the crates (cargo fetch --locked). Writes to OUT_DIR:
#   unwrapped/openmls_wasm.js   wasm-bindgen --target no-modules output
#   openmls_wasm.js             the same, wrapped by wrap-glue.mjs (the shipped glue)
#   openmls_wasm_bg.wasm        the shipped WASM
# Toolchain: Rust (rust-toolchain.toml) with wasm32-unknown-unknown; wasm-bindgen-cli equal to the
# wasm-bindgen crate pin in Cargo.toml; node for wrap-glue.mjs.
#   sh build.sh OUT_DIR
set -eu
out=${1:?usage: sh build.sh OUT_DIR}
cd "$(dirname "$0")"
cargo build --release --locked --offline --target wasm32-unknown-unknown
mkdir -p "$out/unwrapped"
wasm-bindgen --target no-modules --no-typescript --out-dir "$out/unwrapped" target/wasm32-unknown-unknown/release/openmls_wasm.wasm
node wrap-glue.mjs "$out/unwrapped/openmls_wasm.js" "$out/openmls_wasm.js"
mv "$out/unwrapped/openmls_wasm_bg.wasm" "$out/openmls_wasm_bg.wasm"
# Hand the outputs to the host user (the container runs as root).
if [ -n "${OUT_OWNER:-}" ]; then chown -R "$OUT_OWNER" "$out"; fi
