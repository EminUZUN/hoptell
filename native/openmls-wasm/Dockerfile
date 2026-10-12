# The build image of the binding bundle (amendment A11). Every base is pinned by digest (the
# linux/amd64 image manifest; the build runs on the remote Linux x64 machine). The final image holds
# the binding's source as copied from the reviewed commit, the crates fetched with
# `cargo fetch --locked`, the Rust toolchain of rust-toolchain.toml with wasm32-unknown-unknown, and
# wasm-bindgen-cli installed with --locked at the crate pin's version. A build in it (build.sh)
# runs without network and writes only to its output mount. The mapping records this file's digest,
# the image id of the final image, and the two pinned images.

# node for wrap-glue.mjs (the official binary; same Debian release as the Rust image)
FROM --platform=linux/amd64 node:22.22.1-bookworm-slim@sha256:af5818e10f6294a719b4314f34ec03d8e8ad8f571a8d23742418790e6ebb5c90 AS node

FROM --platform=linux/amd64 rust:1.99.0-bookworm@sha256:b36c246742b4d323472588f789601be34eb4af053255e2af53969078ee8dcec7
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN rustup target add wasm32-unknown-unknown --toolchain 1.99.0 \
 && cargo install wasm-bindgen-cli --version 0.2.129 --locked --root /opt/wasm-bindgen \
 && rm -rf /usr/local/cargo/registry/src
ENV PATH=/opt/wasm-bindgen/bin:$PATH
WORKDIR /build/openmls-wasm
COPY Cargo.toml Cargo.lock rust-toolchain.toml build.sh wrap-glue.mjs ./
COPY src ./src
COPY vendor ./vendor
RUN cargo fetch --locked \
 && rustc --version && wasm-bindgen --version && node --version
ENV CARGO_NET_OFFLINE=true
CMD ["sh", "build.sh", "/out"]
