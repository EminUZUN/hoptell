# Vendored crates: the advisory patch

RUSTSEC-2026-0329 (`libcrux-hmac-drbg` < 0.0.2), RUSTSEC-2026-0330 and RUSTSEC-2026-0331
(`libcrux-kem` < 0.0.10) are fixed only by hpke-rs 0.8 and the libcrux 0.0.9/0.0.10 line. The latest
releases of the OpenMLS crypto crates, `openmls_libcrux_crypto` 0.4.0 and `openmls_rust_crypto`
0.6.0, require hpke-rs 0.7 and `libcrux-hmac-drbg` ^0.0.1, so no `cargo update --precise` and no
released version bump reaches the fixed versions. Upstream fixed this in openmls commit
[e0b21a70a5](https://github.com/openmls/openmls/commit/e0b21a70a5) ("bump libcrux crates to next
releases (#2261)", 2026-10-09), which is not in a release yet.

The two crates below are the published crates with only that commit's changes applied, wired in
through `[patch.crates-io]` in `../Cargo.toml`. `openmls` itself stays the published 0.9.1.

**Removal condition:** an openmls release that contains e0b21a70a5 (new `openmls_libcrux_crypto`
and `openmls_rust_crypto` releases). Then pin those releases, delete `vendor/` and the
`[patch.crates-io]` section, and re-run `scripts/cargo-advisories.mjs` and `cargo audit` on the lock.

Both directories are the extracted `.crate` files from crates.io (as in `~/.cargo/registry/src`),
with these differences: the crate's own `Cargo.lock` and the registry's `.cargo-ok` marker are
removed (neither is used by a dependent build), and the edits below are made to the normalized
`Cargo.toml` that Cargo reads. `Cargo.toml.orig` (the authors' manifest, not read by Cargo) and
`.cargo_vcs_info.json` (openmls git 3a3e35de3feeca8f6605143c464d5452ae584d43) are unchanged.

## openmls_libcrux_crypto

- Published version: 0.4.0 (crates.io checksum
  `41e6367fb30f91f21e4d30f4f58a8d3b41f96f55c3e4b5acfa1d6d18c9dd4855`).
- Upstream commit: e0b21a70a5, file `libcrux_crypto/Cargo.toml` and `libcrux_crypto/src/crypto.rs`.
- Applied: the hpke-rs 0.7 → 0.8 and libcrux requirement bumps, and the `hmac` call for
  libcrux-hmac 0.0.9 (writes into a caller-sized buffer). Not applicable to 0.4.0, so not applied:
  the commit's `libcrux-ecdsa` and `libcrux-ml-dsa` bumps (0.4.0 has neither dependency).
- Diff against the published crate:

```diff
diff -ru -x .cargo-ok -x Cargo.lock published/openmls_libcrux_crypto-0.4.0/Cargo.toml vendored/openmls_libcrux_crypto/Cargo.toml
--- published/openmls_libcrux_crypto-0.4.0/Cargo.toml	2006-07-24 04:21:28
+++ vendored/openmls_libcrux_crypto/Cargo.toml	2026-10-09 23:12:52
@@ -58,40 +58,40 @@
 optional = true
 
 [dependencies.hpke-rs]
-version = "0.7"
+version = "0.8"
 features = [
     "hazmat",
     "serialization",
 ]
 
 [dependencies.hpke-rs-crypto]
-version = "0.7"
+version = "0.8"
 
 [dependencies.hpke-rs-libcrux]
-version = "0.7"
+version = "0.8"
 
 [dependencies.libcrux-aead]
-version = "0.0.9"
+version = "0.0.10"
 
 [dependencies.libcrux-ed25519]
-version = "0.0.9"
+version = "0.0.10"
 features = ["rand"]
 
 [dependencies.libcrux-hkdf]
-version = "0.0.8"
+version = "0.0.9"
 
 [dependencies.libcrux-hmac]
-version = "0.0.8"
+version = "0.0.9"
 
 [dependencies.libcrux-hmac-drbg]
-version = "0.0.1"
+version = "0.0.2"
 features = ["rand"]
 
 [dependencies.libcrux-sha2]
-version = "0.0.8"
+version = "0.0.9"
 
 [dependencies.libcrux-traits]
-version = "0.0.8"
+version = "0.0.9"
 
 [dependencies.openmls_memory_storage]
 version = "0.6.0"
diff -ru -x .cargo-ok -x Cargo.lock published/openmls_libcrux_crypto-0.4.0/src/crypto.rs vendored/openmls_libcrux_crypto/src/crypto.rs
--- published/openmls_libcrux_crypto-0.4.0/src/crypto.rs	2006-07-24 04:21:28
+++ vendored/openmls_libcrux_crypto/src/crypto.rs	2026-10-09 23:12:52
@@ -121,7 +121,8 @@
         message: &[u8],
     ) -> Result<SecretVLBytes, CryptoError> {
         let alg = hash_alg(hash_type);
-        let out = libcrux_hmac::hmac(alg, key, message, None);
+        let mut out = vec![0u8; libcrux_hmac::tag_size(alg)];
+        libcrux_hmac::hmac(alg, key, message, &mut out);
         Ok(out.into())
     }
 
```

## openmls_rust_crypto

- Published version: 0.6.0 (crates.io checksum
  `36bf3fe824ead6e81d22f49a9cd7feffca3494979fac14c1248e19516e3625f1`).
- Upstream commit: e0b21a70a5, file `openmls_rust_crypto/Cargo.toml`.
- Applied: the hpke-rs, hpke-rs-crypto and hpke-rs-rust-crypto 0.7 → 0.8 requirement bumps (the
  whole upstream change to this crate). Not compiled into the WASM (an optional `openmls`
  dependency behind `test-utils`), but Cargo.lock records it regardless of features; unpatched, it
  keeps hpke-rs 0.7 and `libcrux-kem` 0.0.9 in the lock.
- Diff against the published crate:

```diff
diff -ru -x .cargo-ok -x Cargo.lock published/openmls_rust_crypto-0.6.0/Cargo.toml vendored/openmls_rust_crypto/Cargo.toml
--- published/openmls_rust_crypto-0.6.0/Cargo.toml	2006-07-24 04:21:28
+++ vendored/openmls_rust_crypto/Cargo.toml	2026-10-09 23:12:52
@@ -71,7 +71,7 @@
 version = "0.13"
 
 [dependencies.hpke]
-version = "0.7"
+version = "0.8"
 features = [
     "hazmat",
     "serialization",
@@ -81,10 +81,10 @@
 package = "hpke-rs"
 
 [dependencies.hpke-rs-crypto]
-version = "0.7"
+version = "0.8"
 
 [dependencies.hpke-rs-rust-crypto]
-version = "0.7"
+version = "0.8"
 features = ["experimental"]
 
 [dependencies.ml-dsa]
```
