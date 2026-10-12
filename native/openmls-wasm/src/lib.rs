//! The bake-off binding (3.1): a small wasm-bindgen API over OpenMLS 0.9.1 with the libcrux
//! provider, for adapters/openmls.js. One `Device` owns the provider (crypto + MemoryStorage),
//! its signer, its loaded groups and the handles of staged (not yet merged) commits and Welcomes.
//!
//! Credential validation is left to the caller, as OpenMLS leaves it to the application: every
//! credential that needs checking is surfaced as a `LeafInfo` (leaf index, identity, signature
//! key) before anything takes effect.
//!
//! Errors never panic across the boundary. Their message starts with "library:" (OpenMLS said
//! no) or "adapter:" (wrong use of this binding: unknown group, unknown handle, bad input).

use std::collections::HashMap;
use std::time::Duration;

use openmls::prelude::*;
use openmls::prelude::tls_codec::{Deserialize as _, Serialize as _};
use openmls_basic_credential::SignatureKeyPair;
use openmls_libcrux_crypto::Provider;
use openmls_traits::signatures::Signer as _;
use openmls_traits::OpenMlsProvider;
use wasm_bindgen::prelude::*;

/// The provider: libcrux with MemoryStorage, or (feature aead-trace, test builds only) the same
/// wrapped so every AEAD seal is fingerprinted.
#[cfg(not(feature = "aead-trace"))]
type AppProvider = Provider;
#[cfg(feature = "aead-trace")]
type AppProvider = aead_trace::TracingProvider;
fn new_provider() -> Result<AppProvider, JsError> {
    #[cfg(not(feature = "aead-trace"))]
    return Provider::new().map_err(lib);
    #[cfg(feature = "aead-trace")]
    return aead_trace::TracingProvider::new().map_err(lib);
}

fn lib<E: std::fmt::Debug>(e: E) -> JsError {
    JsError::new(&format!("library: {e:?}"))
}
fn adapter(msg: &str) -> JsError {
    JsError::new(&format!("adapter: {msg}"))
}

/// The cipher suites the libcrux provider supports as built (with the PQ draft feature).
#[wasm_bindgen]
pub fn supported_suites() -> Result<Vec<u16>, JsError> {
    let provider = Provider::new().map_err(lib)?;
    Ok(provider.crypto().supported_ciphersuites().into_iter().map(u16::from).collect())
}

/// Decode only (no signature verification): parse `bytes` as an MLSMessage with OpenMLS's own
/// tls_codec decoder (every nested structure and extension list, e.g. a GroupInfo's ratchet
/// tree extension), check the body is of `kind` ("MLSMessage" accepts any body), and describe it.
/// A Welcome's GroupInfo is encrypted and so cannot be decoded without the joiner's keys.
#[wasm_bindgen]
pub fn decode(kind: &str, bytes: &[u8]) -> Result<String, JsError> {
    let body = mls_in(bytes)?;
    let (found, description) = match &body {
        MlsMessageBodyIn::PublicMessage(m) => ("MLSMessage", format!("PublicMessage {:?} from {:?}", m.content_type(), m.sender())),
        MlsMessageBodyIn::PrivateMessage(m) => ("MLSMessage", format!("PrivateMessage, aad {} bytes", m.aad().len())),
        MlsMessageBodyIn::Welcome(w) => ("Welcome", format!("Welcome {:?}, {} recipients", w.ciphersuite(), w.secrets().len())),
        MlsMessageBodyIn::GroupInfo(g) => (
            "GroupInfo",
            format!("GroupInfo {:?} epoch {}, {} extensions", g.ciphersuite(), g.epoch().as_u64(), g.extensions().iter().count()),
        ),
        MlsMessageBodyIn::KeyPackage(kp) => {
            let identity = BasicCredential::try_from(kp.unverified_credential().credential)
                .map(|c| String::from_utf8_lossy(c.identity()).into_owned())
                .unwrap_or_else(|_| "non-basic credential".into());
            ("KeyPackage", format!("KeyPackage of {identity}"))
        }
        #[allow(unreachable_patterns)]
        _ => ("MLSMessage", "other MLSMessage".to_string()),
    };
    match kind {
        "MLSMessage" => Ok(description),
        k if k == found => Ok(description),
        "Welcome" | "KeyPackage" | "GroupInfo" => Err(lib(format!("expected {kind}, got {description}"))),
        _ => Err(adapter(&format!("unknown kind {kind}"))),
    }
}

/// A credential to validate, or a member: leaf index (u32::MAX when not in a tree yet),
/// BasicCredential identity, signature public key.
#[wasm_bindgen(getter_with_clone)]
#[derive(Clone)]
pub struct LeafInfo {
    pub index: u32,
    pub identity: Vec<u8>,
    pub signature_key: Vec<u8>,
}

fn leaf_info(index: u32, credential: &Credential, key: &[u8]) -> Result<LeafInfo, JsError> {
    let basic = BasicCredential::try_from(credential.clone()).map_err(lib)?;
    Ok(LeafInfo { index, identity: basic.identity().to_vec(), signature_key: key.to_vec() })
}
fn leaf_node_info(index: u32, leaf: &LeafNode) -> Result<LeafInfo, JsError> {
    leaf_info(index, leaf.credential(), leaf.signature_key().as_slice())
}
fn member_info(m: &Member) -> Result<LeafInfo, JsError> {
    leaf_info(m.index.u32(), &m.credential, &m.signature_key)
}

/// The outcome of an own commit: commit (MLSMessage), Welcome (MLSMessage, empty when none),
/// the ratchet tree of the new epoch (for joiners).
#[wasm_bindgen(getter_with_clone)]
pub struct CommitOut {
    pub commit: Vec<u8>,
    pub welcome: Vec<u8>,
    pub ratchet_tree: Vec<u8>,
}

/// The outcome of process(). kind is "application" | "commit" (a standalone proposal is refused:
/// amendment A7).
/// For "commit", `staged` is a handle for merge_staged / discard_staged, and `to_validate`
/// lists the credentials the commit brings in (committer, update path leaf, added and updated
/// leaves) for the application to check before merging.
#[wasm_bindgen(getter_with_clone)]
pub struct Processed {
    pub kind: String,
    pub plaintext: Vec<u8>,
    pub aad: Vec<u8>,
    pub sender: u32,
    pub epoch: u64,
    pub staged: u32,
    pub new_epoch: u64,
    pub added: Vec<LeafInfo>,
    pub removed: Vec<u32>,
    pub to_validate: Vec<LeafInfo>,
}

/// A staged Welcome: who is in the group before we accept it.
#[wasm_bindgen(getter_with_clone)]
pub struct WelcomeOut {
    pub handle: u32,
    pub group_id: Vec<u8>,
    pub members: Vec<LeafInfo>,
}

#[wasm_bindgen]
pub struct Device {
    provider: AppProvider,
    signer: SignatureKeyPair,
    credential: CredentialWithKey,
    suite: Ciphersuite,
    groups: HashMap<Vec<u8>, MlsGroup>,
    // A received commit, its group id and the storage before processing it (refuse_staged puts
    // that back: decrypting the commit already consumed a sender-ratchet generation).
    staged_commits: HashMap<u32, (Vec<u8>, StagedCommit, Snapshot)>,
    // A staged Welcome and the storage contents before staging it (staging already consumed the
    // KeyPackage private key; a refused Welcome puts it back).
    staged_welcomes: HashMap<u32, (StagedWelcome, Snapshot)>,
    next_handle: u32,
    // Retention (DRIVER-V2 section 1): the limit the adapter set per group, and the past epochs
    // each group holds, oldest first. `held` mirrors the stored MessageSecretsStore: updated on
    // every change the binding makes (merge appends, a deletion drops the oldest), filled by
    // parsing storage when absent, and dropped whenever storage is replaced (restore, rollback).
    limits: HashMap<Vec<u8>, usize>,
    held: HashMap<Vec<u8>, Vec<u64>>,
}

type Snapshot = HashMap<Vec<u8>, Vec<u8>>;

fn suite_from(code: u16) -> Result<Ciphersuite, JsError> {
    Ciphersuite::try_from(code).map_err(|_| adapter(&format!("unknown cipher suite {code}")))
}

fn mls_in(bytes: &[u8]) -> Result<MlsMessageBodyIn, JsError> {
    Ok(MlsMessageIn::tls_deserialize_exact(bytes).map_err(lib)?.extract())
}

/// The past-epoch limit of a group the adapter has not set one for yet (DRIVER-V2's minimum): a
/// message up to 3 epochs older than the receiver's current epoch still decrypts. The adapter
/// sets the limit (set_past_epoch_limit) before every process and after every epoch change.
/// OpenMLS itself keeps every past epoch (PastEpochDeletionPolicy::KeepAll): the binding holds
/// the limit and deletes only when it drops epochs, so OpenMLS never evicts on its own and no
/// policy change rewrites the stored past epochs on the hot path.
const PAST_EPOCHS: usize = 3;
/// DRIVER-V2's bound on past epochs: a group never holds more than this many, however young
/// (the 7-day window and this cap, whichever is stricter; the 3-epoch floor is below it). A
/// message of an epoch beyond it is refused like one past the 7-day window (the epoch is gone).
const MAX_PAST_EPOCHS: usize = 16;
// No ceiling on the past-epoch limit here: DRIVER-V2 keeps every epoch younger than 7 days. A
// capacity bound, if any, is an explicit refusal in the adapter, never a silent deletion here.
/// The skipped-key bounds of design 3.2 (hoptell's lib/mls/policy.js MAX_SKIPPED_PER_SENDER_EPOCH
/// and MAX_FORWARD_GENERATIONS, contract-tested through skip_limits()), as OpenMLS's
/// SenderRatchetConfiguration: per sender and epoch, a window of 10 generations behind the newest
/// one received is kept (so at most 10 keys of skipped generations, in fact at most 9: the newest
/// generation's own slot is in the window), and a message may be at most 200 generations ahead of
/// the next expected one. Stored by OpenMLS with each group when it is created or joined: a group
/// created or joined by an earlier build keeps the bounds it was created with (5 and 1000).
const OUT_OF_ORDER_TOLERANCE: u32 = 10;
const MAXIMUM_FORWARD_DISTANCE: u32 = 200;

fn sender_ratchet() -> SenderRatchetConfiguration {
    SenderRatchetConfiguration::new(OUT_OF_ORDER_TOLERANCE, MAXIMUM_FORWARD_DISTANCE)
}

fn join_config() -> MlsGroupJoinConfig {
    MlsGroupJoinConfig::builder()
        .use_ratchet_tree_extension(false)
        .set_past_epoch_deletion_policy(PastEpochDeletionPolicy::KeepAll)
        .sender_ratchet_configuration(sender_ratchet())
        .build()
}

/// Leaf capabilities with the given lists replacing OpenMLS's defaults (versions and cipher
/// suites stay the defaults; a list not given stays the default).
fn capabilities(extensions: Option<Vec<u16>>, proposals: Option<Vec<u16>>, credentials: Option<Vec<u16>>) -> Capabilities {
    let ext: Option<Vec<ExtensionType>> = extensions.map(|v| v.into_iter().map(ExtensionType::from).collect());
    let prop: Option<Vec<ProposalType>> = proposals.map(|v| v.into_iter().map(ProposalType::from).collect());
    let default_credentials = Capabilities::default().credentials().to_vec();
    let cred: Vec<CredentialType> = match credentials {
        Some(v) => v.into_iter().map(CredentialType::from).collect(),
        None => default_credentials,
    };
    Capabilities::new(None, None, ext.as_deref(), prop.as_deref(), Some(&cred))
}

/// The trace of a PrivateMessage: its sender data, decrypted read-only (RFC 9420 6.3.2).
/// content_type: 1 application, 2 proposal, 3 commit.
#[wasm_bindgen(getter_with_clone)]
pub struct TraceOut {
    pub epoch: u64,
    pub content_type: u8,
    pub sender: u32,
    pub generation: u32,
    pub reuse_guard: Vec<u8>,
}

/// Narrow views of OpenMLS's stored MessageSecretsStore (serde JSON): only the fields a caller
/// needs are materialized; everything else is skipped by serde without being copied.
mod stored {
    use serde::Deserialize;
    use serde_json::value::RawValue;
    #[derive(Deserialize)]
    pub struct Epochs {
        pub past_epoch_trees: Vec<Epoch>,
    }
    #[derive(Deserialize)]
    pub struct Epoch {
        pub epoch: u64,
    }
    /// The message secrets of each epoch left unparsed (borrowed raw JSON), so only the one
    /// epoch asked for is parsed.
    #[derive(Deserialize)]
    pub struct SenderData<'a> {
        #[serde(borrow)]
        pub past_epoch_trees: Vec<EpochRaw<'a>>,
        #[serde(borrow)]
        pub message_secrets: &'a RawValue,
    }
    #[derive(Deserialize)]
    pub struct EpochRaw<'a> {
        pub epoch: u64,
        #[serde(borrow)]
        pub message_secrets: &'a RawValue,
    }
    /// MessageSecrets { sender_data_secret: SenderDataSecret { secret: Secret { value:
    /// SecretVLBytes(VLBytes { vec }) } }, .. }
    #[derive(Deserialize)]
    pub struct Secrets {
        pub sender_data_secret: SenderDataSecret,
    }
    #[derive(Deserialize)]
    pub struct SenderDataSecret {
        pub secret: Secret,
    }
    #[derive(Deserialize)]
    pub struct Secret {
        pub value: Bytes,
    }
    #[derive(Deserialize)]
    pub struct Bytes {
        pub vec: Vec<u8>,
    }
}

/// ExpandWithLabel(secret, label, context, length) (RFC 9420 section 8).
fn expand_with_label(crypto: &impl OpenMlsCrypto, suite: Ciphersuite, secret: &[u8], label: &str, context: &[u8], length: usize) -> Result<Vec<u8>, JsError> {
    let mut info = Vec::new();
    info.extend_from_slice(&(length as u16).to_be_bytes());
    VLBytes::new(format!("MLS 1.0 {label}").into_bytes()).tls_serialize(&mut info).map_err(lib)?;
    VLBytes::new(context.to_vec()).tls_serialize(&mut info).map_err(lib)?;
    Ok(crypto.hkdf_expand(suite.hash_algorithm(), secret, &info, length).map_err(lib)?.as_slice().to_vec())
}

/// The group configuration this binding applies (stored by OpenMLS with each group, so it
/// survives export/import): past epochs kept, out-of-order tolerance, maximum forward distance,
/// and the cap on past epochs (DRIVER-V2 section 1).
#[wasm_bindgen]
pub fn group_config() -> Vec<u32> {
    vec![PAST_EPOCHS as u32, OUT_OF_ORDER_TOLERANCE, MAXIMUM_FORWARD_DISTANCE, MAX_PAST_EPOCHS as u32]
}

/// The skipped-key bounds this binding applies to every group it creates or joins:
/// [out-of-order tolerance (keys kept per sender per epoch), maximum forward distance]. hoptell's
/// contract test asserts they equal lib/mls/policy.js's (amendment A6).
#[wasm_bindgen]
pub fn skip_limits() -> Vec<u32> {
    vec![OUT_OF_ORDER_TOLERANCE, MAXIMUM_FORWARD_DISTANCE]
}

/// The labels this binding signs and verifies for the application (amendment A3): only labels in
/// hoptell's own namespace. MLS's own labels ("LeafNodeTBS", "KeyPackageTBS", "FramedContentTBS",
/// "GroupInfoTBS", ...) never start with this prefix, so a hoptell statement can never be an MLS
/// signature and the binding never signs an MLS structure for the caller (checklist row 1b).
const APP_LABEL_PREFIX: &str = "hoptell-";

fn app_label(label: &str) -> Result<(), JsError> {
    let rest = label.strip_prefix(APP_LABEL_PREFIX).ok_or_else(|| adapter(&format!("refused label {label:?}: only labels starting with {APP_LABEL_PREFIX:?} are signed or verified")))?;
    if rest.is_empty() || label.len() > 64 || !label.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
        return Err(adapter(&format!("refused label {label:?}: lowercase letters, digits and '-' only, at most 64 bytes")));
    }
    Ok(())
}

/// The bytes SignWithLabel(label, content) signs (RFC 9420 section 5.1.2): SignContent { label<V>
/// = "MLS 1.0 " + label, content<V> }, OpenMLS's own encoding.
fn sign_content(label: &str, content: &[u8]) -> Result<Vec<u8>, JsError> {
    app_label(label)?;
    SignContent::new(label, content.to_vec().into()).tls_serialize_detached().map_err(lib)
}

/// VerifyWithLabel (RFC 9420 section 5.1.2) of `signature` over (label, content) by the raw
/// signature public key `public_key`, with the suite's signature scheme (Ed25519 for the suites
/// hoptell uses). False for a wrong signature, key or content; an error for a refused label or an
/// unknown suite.
#[wasm_bindgen]
pub fn verify_with_label(suite: u16, public_key: &[u8], label: &str, content: &[u8], signature: &[u8]) -> Result<bool, JsError> {
    let suite = suite_from(suite)?;
    let payload = sign_content(label, content)?;
    let provider = Provider::new().map_err(lib)?;
    Ok(provider.crypto().verify_signature(suite.signature_algorithm(), &payload, public_key, signature).is_ok())
}

#[wasm_bindgen]
impl Device {
    /// A new device: an Ed25519 key pair (stored in the provider) and a BasicCredential.
    #[wasm_bindgen(constructor)]
    pub fn new(suite: u16, identity: &[u8]) -> Result<Device, JsError> {
        let suite = suite_from(suite)?;
        let provider = new_provider()?;
        provider.crypto().supports(suite).map_err(lib)?;
        let signer = SignatureKeyPair::new(suite.signature_algorithm()).map_err(lib)?;
        signer.store(provider.storage()).map_err(lib)?;
        let credential = CredentialWithKey {
            credential: BasicCredential::new(identity.to_vec()).into(),
            signature_key: signer.public().into(),
        };
        Ok(Device::from_parts(provider, signer, credential, suite))
    }

    fn from_parts(provider: AppProvider, signer: SignatureKeyPair, credential: CredentialWithKey, suite: Ciphersuite) -> Device {
        Device {
            provider,
            signer,
            credential,
            suite,
            groups: HashMap::new(),
            staged_commits: HashMap::new(),
            staged_welcomes: HashMap::new(),
            next_handle: 1,
            limits: HashMap::new(),
            held: HashMap::new(),
        }
    }

    pub fn suite(&self) -> u16 {
        self.suite.into()
    }
    pub fn signature_public_key(&self) -> Vec<u8> {
        self.signer.to_public_vec()
    }

    /// SignWithLabel (RFC 9420 section 5.1.2) with this device's signature key, for hoptell's own
    /// statements (rotation, revocation: amendment A3). Only labels in hoptell's namespace are
    /// signed (see APP_LABEL_PREFIX); the key itself never leaves the binding.
    pub fn sign_with_label(&self, label: &str, content: &[u8]) -> Result<Vec<u8>, JsError> {
        let payload = sign_content(label, content)?;
        self.signer.sign(&payload).map_err(lib)
    }

    /// A KeyPackage as an MLSMessage; its private part is stored in the provider. The leaf
    /// capabilities' extension, proposal and credential type lists replace the defaults when
    /// given.
    pub fn key_package(
        &self,
        lifetime_seconds: Option<u32>,
        extensions: Option<Vec<u16>>,
        proposals: Option<Vec<u16>>,
        credentials: Option<Vec<u16>>,
    ) -> Result<Vec<u8>, JsError> {
        let mut builder = KeyPackage::builder();
        if let Some(secs) = lifetime_seconds {
            builder = builder.key_package_lifetime(Lifetime::new(secs as u64));
        }
        if extensions.is_some() || proposals.is_some() || credentials.is_some() {
            builder = builder.leaf_node_capabilities(capabilities(extensions, proposals, credentials));
        }
        let bundle = builder.build(self.suite, &self.provider, &self.signer, self.credential.clone()).map_err(lib)?;
        MlsMessageOut::from(bundle.key_package().clone()).tls_serialize_detached().map_err(lib)
    }

    /// Validate a KeyPackage (signatures, version, suite: the library's part) and return its
    /// credential for the oracle.
    pub fn key_package_info(&self, key_package: &[u8]) -> Result<LeafInfo, JsError> {
        let kp = self.validate_key_package(key_package)?;
        leaf_node_info(u32::MAX, kp.leaf_node())
    }

    /// Delete the private parts of expired KeyPackages (amendment A10, checklist row 3): every
    /// KeyPackage bundle in storage (the KeyPackage, its init private key and its leaf node
    /// private key, stored together under the package's KeyPackageRef) whose lifetime `not_after`
    /// is earlier than `now_seconds - grace_seconds` is deleted; a package whose `not_after` is at
    /// or after that point is never touched. Returns the KeyPackageRefs of the deleted packages,
    /// sorted. A Welcome for a deleted package can no longer be processed (no key matches it).
    /// The caller gives the time (hoptell's clock, so tests control it). On any error the storage
    /// is put back as it was before the call and nothing is deleted.
    pub fn prune_key_packages(&mut self, now_seconds: u64, grace_seconds: u64) -> Result<Vec<js_value_bytes::Bytes>, JsError> {
        let cutoff = now_seconds.saturating_sub(grace_seconds);
        let snapshot = self.snapshot()?;
        match self.prune_inner(cutoff) {
            Ok(refs) => Ok(refs.into_iter().map(|r| js_value_bytes::Bytes { bytes: r.as_slice().to_vec() }).collect()),
            Err(e) => {
                self.restore(snapshot)?;
                Err(e)
            }
        }
    }

    fn prune_inner(&mut self, cutoff: u64) -> Result<Vec<KeyPackageRef>, JsError> {
        // MemoryStorage keys a bundle as "KeyPackage" ++ json(KeyPackageRef) ++ storage version
        // (u16 big-endian); its value is the bundle as serde JSON. No other label starts with
        // "KeyPackage". An entry that does not parse fails the whole call (fail closed: nothing is
        // deleted, the storage is restored).
        const LABEL: &[u8] = b"KeyPackage";
        let version = openmls_traits::storage::CURRENT_VERSION.to_be_bytes();
        let mut expired = Vec::new();
        {
            let values = self.provider.storage().values.read().map_err(|_| adapter("storage lock"))?;
            for (key, value) in values.iter() {
                if !key.starts_with(LABEL) {
                    continue;
                }
                if key.len() < LABEL.len() + 2 || key[key.len() - 2..] != version {
                    return Err(adapter("a stored KeyPackage entry of another storage version"));
                }
                let stored_ref: KeyPackageRef = serde_json::from_slice(&key[LABEL.len()..key.len() - 2]).map_err(|e| adapter(&format!("a stored KeyPackage reference: {e}")))?;
                let bundle: KeyPackageBundle = serde_json::from_slice(value).map_err(|e| adapter(&format!("a stored KeyPackage bundle: {e}")))?;
                if bundle.key_package().hash_ref(self.provider.crypto()).map_err(lib)? != stored_ref {
                    return Err(adapter("a stored KeyPackage bundle is not under its own reference"));
                }
                if bundle.key_package().life_time().not_after() < cutoff {
                    expired.push(stored_ref);
                }
            }
        }
        expired.sort_by(|a, b| a.as_slice().cmp(b.as_slice()));
        let storage = self.provider.storage();
        for r in &expired {
            <openmls_memory_storage::MemoryStorage as openmls_traits::storage::StorageProvider<{ openmls_traits::storage::CURRENT_VERSION }>>::delete_key_package(storage, r).map_err(lib)?;
        }
        Ok(expired)
    }

    fn validate_key_package(&self, bytes: &[u8]) -> Result<KeyPackage, JsError> {
        match mls_in(bytes)? {
            MlsMessageBodyIn::KeyPackage(kp) => kp.validate(self.provider.crypto(), ProtocolVersion::Mls10).map_err(lib),
            _ => Err(adapter("not a KeyPackage message")),
        }
    }

    /// A new group. With required extension or proposal types, the group context carries a
    /// required_capabilities extension with them, and the creator's own leaf advertises them.
    pub fn create_group(&mut self, group_id: &[u8], required_extensions: Option<Vec<u16>>, required_proposals: Option<Vec<u16>>) -> Result<(), JsError> {
        let mut builder = MlsGroupCreateConfig::builder()
            .ciphersuite(self.suite)
            .use_ratchet_tree_extension(false)
            .set_past_epoch_deletion_policy(PastEpochDeletionPolicy::KeepAll)
            .sender_ratchet_configuration(sender_ratchet());
        if required_extensions.is_some() || required_proposals.is_some() {
            let ext = required_extensions.unwrap_or_default();
            let prop = required_proposals.unwrap_or_default();
            let ext_types: Vec<ExtensionType> = ext.iter().copied().map(ExtensionType::from).collect();
            let prop_types: Vec<ProposalType> = prop.iter().copied().map(ProposalType::from).collect();
            let required = RequiredCapabilitiesExtension::new(&ext_types, &prop_types, &[]);
            builder = builder
                .with_group_context_extensions(Extensions::single(Extension::RequiredCapabilities(required)).map_err(lib)?)
                .capabilities(capabilities(Some(ext), Some(prop), None));
        }
        let config = builder.build();
        let group = MlsGroup::new_with_group_id(&self.provider, &self.signer, &config, GroupId::from_slice(group_id), self.credential.clone())
            .map_err(lib)?;
        self.groups.insert(group_id.to_vec(), group);
        Ok(())
    }

    pub fn group_ids(&self) -> Vec<js_value_bytes::Bytes> {
        self.groups.keys().map(|k| js_value_bytes::Bytes { bytes: k.clone() }).collect()
    }

    fn group(&self, group_id: &[u8]) -> Result<&MlsGroup, JsError> {
        self.groups.get(group_id).ok_or_else(|| adapter("unknown group"))
    }

    pub fn epoch(&self, group_id: &[u8]) -> Result<u64, JsError> {
        Ok(self.group(group_id)?.epoch().as_u64())
    }
    pub fn own_index(&self, group_id: &[u8]) -> Result<u32, JsError> {
        Ok(self.group(group_id)?.own_leaf_index().u32())
    }
    pub fn epoch_authenticator(&self, group_id: &[u8]) -> Result<Vec<u8>, JsError> {
        Ok(self.group(group_id)?.epoch_authenticator().as_slice().to_vec())
    }
    pub fn members(&self, group_id: &[u8]) -> Result<Vec<LeafInfo>, JsError> {
        self.group(group_id)?.members().map(|m| member_info(&m)).collect()
    }
    /// A signed GroupInfo of the current epoch (an MLSMessage) with the ratchet tree extension.
    pub fn group_info(&self, group_id: &[u8]) -> Result<Vec<u8>, JsError> {
        let msg = self.group(group_id)?.export_group_info(self.provider.crypto(), &self.signer, true).map_err(lib)?;
        msg.tls_serialize_detached().map_err(lib)
    }
    pub fn is_active(&self, group_id: &[u8]) -> Result<bool, JsError> {
        Ok(self.group(group_id)?.is_active())
    }
    /// The skipped-key bounds stored with this group ([out-of-order tolerance, maximum forward
    /// distance]): skip_limits() for a group this build created or joined; a group created or
    /// joined by an earlier build keeps the bounds it was made with (OpenMLS stores them with the
    /// group), so the caller can tell (amendment A6). Read-only.
    pub fn group_skip_limits(&self, group_id: &[u8]) -> Result<Vec<u32>, JsError> {
        let c = self.group(group_id)?.configuration().sender_ratchet_configuration();
        Ok(vec![c.out_of_order_tolerance(), c.maximum_forward_distance()])
    }

    /// An application message (PrivateMessage) with the given AAD.
    pub fn encrypt(&mut self, group_id: &[u8], plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, JsError> {
        let (provider, signer) = (&self.provider, &self.signer);
        let group = self.groups.get_mut(group_id).ok_or_else(|| adapter("unknown group"))?;
        group.set_aad(aad.to_vec());
        let msg = group.create_message(provider, signer, plaintext).map_err(lib)?;
        msg.tls_serialize_detached().map_err(lib)
    }

    /// An own commit, kept as the group's pending commit until merge_pending / clear_pending.
    /// Key packages must have been checked (key_package_info + oracle) by the caller.
    pub fn commit(&mut self, group_id: &[u8], add: Vec<js_value_bytes::Bytes>, remove: Vec<u32>, update: bool) -> Result<CommitOut, JsError> {
        let key_packages = add.iter().map(|b| self.validate_key_package(&b.bytes)).collect::<Result<Vec<_>, _>>()?;
        let (provider, signer) = (&self.provider, &self.signer);
        let group = self.groups.get_mut(group_id).ok_or_else(|| adapter("unknown group"))?;
        if group.pending_commit().is_some() {
            return Err(adapter("a pending commit exists; merge or discard it first"));
        }
        let bundle = group
            .commit_builder()
            .propose_adds(key_packages)
            .propose_removals(remove.into_iter().map(LeafNodeIndex::new))
            .force_self_update(update)
            .consume_proposal_store(true)
            .load_psks(provider.storage())
            .map_err(lib)?
            .build(provider.rand(), provider.crypto(), signer, |_| true)
            .map_err(lib)?
            .stage_commit(provider)
            .map_err(lib)?;
        let (commit, welcome, _group_info) = bundle.into_messages();
        let pending = group.pending_commit().ok_or_else(|| adapter("no pending commit after staging"))?;
        let tree = pending
            .export_ratchet_tree(provider.crypto(), group.export_ratchet_tree())
            .map_err(lib)?
            .ok_or_else(|| adapter("own staged commit has no tree"))?;
        Ok(CommitOut {
            commit: commit.tls_serialize_detached().map_err(lib)?,
            welcome: match welcome {
                Some(w) => w.tls_serialize_detached().map_err(lib)?,
                None => Vec::new(),
            },
            ratchet_tree: tree.tls_serialize_detached().map_err(lib)?,
        })
    }

    pub fn merge_pending(&mut self, group_id: &[u8]) -> Result<(), JsError> {
        if self.group(group_id)?.pending_commit().is_none() {
            return Err(adapter("no pending commit"));
        }
        self.before_epoch_change(group_id)?;
        let provider = &self.provider;
        let group = self.groups.get_mut(group_id).ok_or_else(|| adapter("unknown group"))?;
        let left = group.epoch().as_u64();
        group.merge_pending_commit(provider).map_err(lib)?;
        self.after_epoch_change(group_id, left);
        Ok(())
    }

    pub fn clear_pending(&mut self, group_id: &[u8]) -> Result<(), JsError> {
        let provider = &self.provider;
        let group = self.groups.get_mut(group_id).ok_or_else(|| adapter("unknown group"))?;
        group.clear_pending_commit(provider.storage()).map_err(lib)
    }

    /// Process an incoming MLSMessage (PublicMessage or PrivateMessage). On any error the group
    /// is put back as it was before (OpenMLS has already advanced the secret tree by then).
    pub fn process(&mut self, group_id: &[u8], message: &[u8]) -> Result<Processed, JsError> {
        self.group(group_id)?;
        let snapshot = self.snapshot()?;
        match self.process_inner(group_id, message, &snapshot) {
            Ok(p) => Ok(p),
            Err(e) => {
                self.rollback(group_id, snapshot)?;
                Err(e)
            }
        }
    }

    fn process_inner(&mut self, group_id: &[u8], message: &[u8], snapshot: &Snapshot) -> Result<Processed, JsError> {
        let protocol: ProtocolMessage = match mls_in(message)? {
            MlsMessageBodyIn::PublicMessage(m) => m.into(),
            MlsMessageBodyIn::PrivateMessage(m) => m.into(),
            _ => return Err(adapter("not a group message")),
        };
        let provider = &self.provider;
        let group = self.groups.get_mut(group_id).ok_or_else(|| adapter("unknown group"))?;
        let processed = group.process_message(provider, protocol).map_err(lib)?;
        let sender = match processed.sender() {
            Sender::Member(i) => i.u32(),
            _ => u32::MAX,
        };
        let epoch = processed.epoch().as_u64();
        let aad = processed.aad().to_vec();
        let mut out = Processed {
            kind: String::new(),
            plaintext: Vec::new(),
            aad,
            sender,
            epoch,
            staged: 0,
            new_epoch: 0,
            added: Vec::new(),
            removed: Vec::new(),
            to_validate: Vec::new(),
        };
        // The committer's credential as it is in the tree now (replaced below by the update path
        // leaf when the commit carries one).
        let committer = group.members().find(|m| m.index.u32() == sender).map(|m| member_info(&m)).transpose()?;
        match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(app) => {
                out.kind = "application".into();
                out.plaintext = app.into_bytes();
            }
            ProcessedMessageContent::ProposalMessage(_) | ProcessedMessageContent::ExternalJoinProposalMessage(_) => {
                // Standalone proposals are not used (amendment A7): refused here, so process()
                // restores the storage snapshot taken before this message (OpenMLS already
                // consumed a handshake generation decrypting it) and reloads the group, exactly as
                // for a refused commit. Nothing of the proposal is kept.
                return Err(adapter("unsupported: a standalone proposal is refused (proposals are only accepted inside a commit); the group is as before this message"));
            }
            ProcessedMessageContent::StagedCommitMessage(staged) => {
                out.kind = "commit".into();
                out.new_epoch = staged.epoch().as_u64();
                for add in staged.add_proposals() {
                    let info = leaf_node_info(u32::MAX, add.add_proposal().key_package().leaf_node())?;
                    out.added.push(info.clone());
                    out.to_validate.push(info);
                }
                for rem in staged.remove_proposals() {
                    out.removed.push(rem.remove_proposal().removed().u32());
                }
                for upd in staged.update_proposals() {
                    let idx = match upd.sender() {
                        Sender::Member(i) => i.u32(),
                        _ => u32::MAX,
                    };
                    out.to_validate.push(leaf_node_info(idx, upd.update_proposal().leaf_node())?);
                }
                match staged.update_path_leaf_node() {
                    Some(leaf) => out.to_validate.push(leaf_node_info(sender, leaf)?),
                    None => out.to_validate.extend(committer),
                }
                let handle = self.next_handle;
                self.next_handle += 1;
                self.staged_commits.insert(handle, (group_id.to_vec(), *staged, snapshot.clone()));
                out.staged = handle;
            }
            other => return Err(adapter(&format!("unexpected processed content: {other:?}"))),
        }
        Ok(out)
    }

    /// Test-only (feature test-proposals, built into pkg-trace, never into pkg): send a standalone
    /// proposal as a member would, kind "remove" (of leaf `leaf`) or "update" (own leaf), and drop
    /// it from this device's own proposal store at once, so its own later commits never include
    /// it. The harness uses it to show that a receiving device refuses it (amendment A7).
    #[cfg(feature = "test-proposals")]
    pub fn propose_for_test(&mut self, group_id: &[u8], kind: &str, leaf: u32) -> Result<Vec<u8>, JsError> {
        let (provider, signer) = (&self.provider, &self.signer);
        let group = self.groups.get_mut(group_id).ok_or_else(|| adapter("unknown group"))?;
        let (msg, _) = match kind {
            "remove" => group.propose_remove_member(provider, signer, LeafNodeIndex::new(leaf)).map_err(lib)?,
            "update" => group.propose_self_update(provider, signer, LeafNodeParameters::default()).map_err(lib)?,
            _ => return Err(adapter(&format!("unknown proposal kind {kind}"))),
        };
        group.clear_pending_proposals(provider.storage()).map_err(lib)?;
        msg.tls_serialize_detached().map_err(lib)
    }

    pub fn merge_staged(&mut self, handle: u32) -> Result<(), JsError> {
        let group_id = self.staged_commits.get(&handle).ok_or_else(|| adapter("unknown staged commit"))?.0.clone();
        self.before_epoch_change(&group_id)?;
        let (group_id, staged, _) = self.staged_commits.remove(&handle).ok_or_else(|| adapter("unknown staged commit"))?;
        let provider = &self.provider;
        let group = self.groups.get_mut(&group_id).ok_or_else(|| adapter("unknown group"))?;
        let left = group.epoch().as_u64();
        group.merge_staged_commit(provider, staged).map_err(lib)?;
        self.after_epoch_change(&group_id, left);
        Ok(())
    }

    /// Drop a staged commit (another commit won). The consumed generation stays consumed.
    pub fn discard_staged(&mut self, handle: u32) -> Result<(), JsError> {
        self.staged_commits.remove(&handle).map(|_| ()).ok_or_else(|| adapter("unknown staged commit"))
    }

    /// Drop a staged commit the application refused, and put the group back as it was before
    /// processing it, as if it had never been received.
    pub fn refuse_staged(&mut self, handle: u32) -> Result<(), JsError> {
        let (group_id, _, snapshot) = self.staged_commits.remove(&handle).ok_or_else(|| adapter("unknown staged commit"))?;
        self.rollback(&group_id, snapshot)
    }

    // --- Retention (DRIVER-V2 section 1) ---------------------------------------------------

    /// The stored MessageSecretsStore entry of the group (serde JSON in the MemoryStorage map,
    /// key "MessageSecrets" ++ json(group id) ++ storage version 1), parsed narrowly by `f`
    /// straight from the stored bytes (no copy of the entry, no copy of the secrets `f` skips).
    fn with_stored_secrets<T>(&self, group: &MlsGroup, f: impl FnOnce(&[u8]) -> Result<T, JsError>) -> Result<T, JsError> {
        let mut key = b"MessageSecrets".to_vec();
        key.extend(serde_json::to_vec(group.group_id()).map_err(lib)?);
        key.extend_from_slice(&openmls_traits::storage::CURRENT_VERSION.to_be_bytes());
        let values = self.provider.storage().values.read().map_err(|_| adapter("storage lock"))?;
        let bytes = values.get(&key).ok_or_else(|| adapter("no message secrets in storage"))?;
        f(bytes)
    }

    /// The past epochs whose message secrets the group holds, oldest first (OpenMLS's order),
    /// as stored: only the epoch numbers are parsed, every secret is skipped. Evidence (tests
    /// compare it with past_epochs); the hot path uses the binding's record.
    pub fn past_epochs_stored(&self, group_id: &[u8]) -> Result<Vec<u64>, JsError> {
        self.with_stored_secrets(self.group(group_id)?, |bytes| {
            let store: stored::Epochs = serde_json::from_slice(bytes).map_err(|e| adapter(&format!("stored message secrets: {e}")))?;
            Ok(store.past_epoch_trees.into_iter().map(|t| t.epoch).collect())
        })
    }

    /// The past epochs whose message secrets the group holds, oldest first: the binding's record
    /// (filled from storage when absent, so it equals past_epochs_stored).
    pub fn past_epochs(&mut self, group_id: &[u8]) -> Result<Vec<u64>, JsError> {
        Ok(self.held_mut(group_id)?.clone())
    }

    fn held_mut(&mut self, group_id: &[u8]) -> Result<&mut Vec<u64>, JsError> {
        if !self.held.contains_key(group_id) {
            let epochs = self.past_epochs_stored(group_id)?;
            self.held.insert(group_id.to_vec(), epochs);
        }
        Ok(self.held.get_mut(group_id).expect("just filled"))
    }

    /// The group's past-epoch limit: the one the adapter last set, else (a group created, joined
    /// or imported since) the limit OpenMLS stored for it (MaxEpochs in states written before
    /// the binding held the limit), else the minimum.
    pub fn past_epoch_limit(&self, group_id: &[u8]) -> Result<u32, JsError> {
        if let Some(limit) = self.limits.get(group_id) {
            return Ok((*limit).min(u32::MAX as usize) as u32);
        }
        Ok(match self.group(group_id)?.past_epoch_deletion_policy() {
            PastEpochDeletionPolicy::MaxEpochs(n) => (*n).min(u32::MAX as usize) as u32,
            PastEpochDeletionPolicy::KeepAll => PAST_EPOCHS as u32,
        })
    }

    /// OpenMLS keeps every past epoch of the group (KeepAll), so it never evicts on its own. A
    /// group stored with MaxEpochs (an older state) is switched once; KeepAll only grows the
    /// store's capacity and deletes nothing.
    fn ensure_keep_all(&mut self, group_id: &[u8]) -> Result<(), JsError> {
        let provider = &self.provider;
        let group = self.groups.get_mut(group_id).ok_or_else(|| adapter("unknown group"))?;
        if !matches!(group.past_epoch_deletion_policy(), PastEpochDeletionPolicy::KeepAll) {
            group.set_past_epoch_deletion_policy(provider, PastEpochDeletionPolicy::KeepAll).map_err(lib)?;
        }
        Ok(())
    }

    /// Set the group's past-epoch limit to `limit` (at most MAX_PAST_EPOCHS), deleting the oldest
    /// past epochs beyond it.
    /// Deletion is delete_past_epoch_secrets(max_past_epochs(limit)), which drops the oldest and
    /// keeps the order (OpenMLS's own resize, set_configuration or a smaller MaxEpochs, drops the
    /// wrong epochs when the store is not full: probes/openmls-resize.mjs). A limit at or above
    /// the epochs held writes nothing, so this costs nothing when no epoch expires (it runs
    /// before every process).
    pub fn set_past_epoch_limit(&mut self, group_id: &[u8], limit: u32) -> Result<(), JsError> {
        let limit = (limit as usize).min(MAX_PAST_EPOCHS);
        self.ensure_keep_all(group_id)?;
        let held = self.held_mut(group_id)?.len();
        if held > limit {
            let provider = &self.provider;
            let group = self.groups.get_mut(group_id).ok_or_else(|| adapter("unknown group"))?;
            // The duration is never reached: only max_past_epochs deletes (oldest first).
            group
                .delete_past_epoch_secrets(provider, PastEpochDeletion::older_than_duration(Duration::MAX).max_past_epochs(limit))
                .map_err(lib)?;
            self.held_mut(group_id)?.drain(0..held - limit);
        }
        self.limits.insert(group_id.to_vec(), limit);
        Ok(())
    }

    /// Evidence only: OpenMLS's own runtime limit change, MlsGroup::set_configuration with a
    /// join config whose max_past_epochs is `limit` (no workaround).
    pub fn set_configuration_raw(&mut self, group_id: &[u8], limit: u32) -> Result<(), JsError> {
        self.held.remove(group_id);
        self.limits.remove(group_id);
        let provider = &self.provider;
        let group = self.groups.get_mut(group_id).ok_or_else(|| adapter("unknown group"))?;
        let config = MlsGroupJoinConfig::builder()
            .use_ratchet_tree_extension(false)
            .max_past_epochs(limit as usize)
            .sender_ratchet_configuration(sender_ratchet())
            .build();
        group.set_configuration(provider.storage(), &config).map_err(lib)
    }

    /// Before an epoch change: OpenMLS must keep the epoch that becomes past (only the adapter's
    /// recompute, or an explicit release, deletes), and the record must be current.
    fn before_epoch_change(&mut self, group_id: &[u8]) -> Result<(), JsError> {
        self.ensure_keep_all(group_id)?;
        self.held_mut(group_id)?;
        Ok(())
    }

    /// After a merge: the epoch left became the newest past epoch (KeepAll: nothing evicted).
    fn after_epoch_change(&mut self, group_id: &[u8], left: u64) {
        if let Some(held) = self.held.get_mut(group_id) {
            held.push(left);
        }
    }

    // --- Trace (DRIVER-V2 section 2) ------------------------------------------------------

    /// Decrypt the sender data of a PrivateMessage of this group (sent or received) with the
    /// sender-data secret of its epoch, read from storage (current epoch or a retained past
    /// one). Changes nothing; returns no secret material.
    pub fn trace(&self, group_id: &[u8], message: &[u8]) -> Result<TraceOut, JsError> {
        let group = self.group(group_id)?;
        let suite = group.ciphersuite();
        // MLSMessage { version u16, wire_format u16 = mls_private_message (2), PrivateMessage {
        //   group_id<V>, epoch u64, content_type u8, authenticated_data<V>,
        //   encrypted_sender_data<V>, ciphertext<V> } }
        let mut r: &[u8] = message;
        let version = u16::tls_deserialize(&mut r).map_err(lib)?;
        let wire_format = u16::tls_deserialize(&mut r).map_err(lib)?;
        if version != 1 || wire_format != 2 {
            return Err(adapter("not an MLS 1.0 PrivateMessage"));
        }
        let msg_group = VLBytes::tls_deserialize(&mut r).map_err(lib)?;
        let epoch = u64::tls_deserialize(&mut r).map_err(lib)?;
        let content_type = u8::tls_deserialize(&mut r).map_err(lib)?;
        let _aad = VLBytes::tls_deserialize(&mut r).map_err(lib)?;
        let encrypted_sender_data = VLBytes::tls_deserialize(&mut r).map_err(lib)?;
        let ciphertext = VLBytes::tls_deserialize(&mut r).map_err(lib)?;
        if !r.is_empty() {
            return Err(adapter("trailing bytes after the PrivateMessage"));
        }
        if msg_group.as_slice() != group_id {
            return Err(adapter("a message of another group"));
        }
        let current = group.epoch().as_u64();
        if epoch > current {
            return Err(adapter(&format!("epoch {epoch} is in the future (current {current})")));
        }
        // Only that epoch's sender-data secret is copied out of storage (and erased after use).
        let mut sender_data_secret = self.with_stored_secrets(group, |bytes| {
            let store: stored::SenderData = serde_json::from_slice(bytes).map_err(|e| adapter(&format!("stored message secrets: {e}")))?;
            let raw = if epoch == current {
                store.message_secrets
            } else {
                store.past_epoch_trees.into_iter().find(|t| t.epoch == epoch).ok_or_else(|| adapter(&format!("epoch {epoch} is no longer held")))?.message_secrets
            };
            let secrets: stored::Secrets = serde_json::from_str(raw.get()).map_err(|e| adapter(&format!("stored message secrets: {e}")))?;
            Ok(secrets.sender_data_secret.secret.value.vec)
        })?;
        let ct = ciphertext.as_slice();
        let sample = &ct[..ct.len().min(suite.hash_length())];
        let crypto = self.provider.crypto();
        let derived = (|| {
            let key = expand_with_label(crypto, suite, &sender_data_secret, "key", sample, suite.aead_key_length())?;
            let nonce = expand_with_label(crypto, suite, &sender_data_secret, "nonce", sample, suite.aead_nonce_length())?;
            Ok::<_, JsError>((key, nonce))
        })();
        sender_data_secret.iter_mut().for_each(|b| *b = 0);
        let (mut key, mut nonce) = derived?;
        // SenderDataAAD { group_id<V>, epoch u64, content_type u8 }
        let mut sd_aad = Vec::new();
        msg_group.tls_serialize(&mut sd_aad).map_err(lib)?;
        sd_aad.extend_from_slice(&epoch.to_be_bytes());
        sd_aad.push(content_type);
        let plain = crypto.aead_decrypt(suite.aead_algorithm(), &key, encrypted_sender_data.as_slice(), &nonce, &sd_aad);
        key.iter_mut().for_each(|b| *b = 0);
        nonce.iter_mut().for_each(|b| *b = 0);
        let plain = plain.map_err(lib)?;
        // SenderData { leaf_index u32, generation u32, reuse_guard[4] }
        if plain.len() != 12 {
            return Err(lib(format!("sender data of {} bytes", plain.len())));
        }
        Ok(TraceOut {
            epoch,
            content_type,
            sender: u32::from_be_bytes(plain[0..4].try_into().unwrap()),
            generation: u32::from_be_bytes(plain[4..8].try_into().unwrap()),
            reuse_guard: plain[8..12].to_vec(),
        })
    }

    fn snapshot(&self) -> Result<Snapshot, JsError> {
        Ok(self.provider.storage().values.read().map_err(|_| adapter("storage lock"))?.clone())
    }

    /// Restore the storage and reload the group from it (its in-memory copy has moved on too).
    fn rollback(&mut self, group_id: &[u8], snapshot: Snapshot) -> Result<(), JsError> {
        self.restore(snapshot)?;
        let group = MlsGroup::load(self.provider.storage(), &GroupId::from_slice(group_id))
            .map_err(lib)?
            .ok_or_else(|| adapter("group not in storage"))?;
        self.groups.insert(group_id.to_vec(), group);
        Ok(())
    }

    /// Stage a Welcome (with the ratchet tree when it is not in the Welcome). Nothing is joined
    /// until join_finish; join_discard restores the storage (the KeyPackage private key).
    pub fn join_stage(&mut self, welcome: &[u8], ratchet_tree: Option<Vec<u8>>) -> Result<WelcomeOut, JsError> {
        let welcome = match mls_in(welcome)? {
            MlsMessageBodyIn::Welcome(w) => w,
            _ => return Err(adapter("not a Welcome message")),
        };
        let tree = ratchet_tree.map(|t| RatchetTreeIn::tls_deserialize_exact(&t[..]).map_err(lib)).transpose()?;
        let snapshot = self.snapshot()?;
        let staged = (|| {
            let mut builder = StagedWelcome::build_from_welcome(&self.provider, &join_config(), welcome).map_err(lib)?;
            if let Some(tree) = tree {
                builder = builder.with_ratchet_tree(tree);
            }
            builder.build().map_err(lib)
        })();
        let staged = match staged {
            Ok(s) => s,
            Err(e) => {
                self.restore(snapshot)?;
                return Err(e);
            }
        };
        let members = staged.members().map(|m| member_info(&m)).collect::<Result<Vec<_>, _>>()?;
        let group_id = staged.group_context().group_id().as_slice().to_vec();
        let handle = self.next_handle;
        self.next_handle += 1;
        self.staged_welcomes.insert(handle, (staged, snapshot));
        Ok(WelcomeOut { handle, group_id, members })
    }

    pub fn join_finish(&mut self, handle: u32) -> Result<Vec<u8>, JsError> {
        let (staged, snapshot) = self.staged_welcomes.remove(&handle).ok_or_else(|| adapter("unknown staged welcome"))?;
        match staged.into_group(&self.provider) {
            Ok(group) => {
                let id = group.group_id().as_slice().to_vec();
                self.groups.insert(id.clone(), group);
                Ok(id)
            }
            Err(e) => {
                self.restore(snapshot)?;
                Err(lib(e))
            }
        }
    }

    pub fn join_discard(&mut self, handle: u32) -> Result<(), JsError> {
        let (_, snapshot) = self.staged_welcomes.remove(&handle).ok_or_else(|| adapter("unknown staged welcome"))?;
        self.restore(snapshot)
    }

    /// Put the storage back; the past-epoch record is re-read from it when next needed.
    fn restore(&mut self, snapshot: Snapshot) -> Result<(), JsError> {
        *self.provider.storage().values.write().map_err(|_| adapter("storage lock"))? = snapshot;
        self.held.clear();
        Ok(())
    }

    /// The whole device: suite, identity, signature public key, group ids, the past-epoch limit
    /// set per group, and every entry of the provider's MemoryStorage (which holds the signer's private key, KeyPackage private
    /// keys, group state, secret tree, pending commit, proposals). Staged commits/Welcomes not
    /// yet merged are in memory only and are not exported.
    pub fn export_state(&self) -> Result<Vec<u8>, JsError> {
        let mut w = Writer(Vec::new());
        w.0.push(2); // format version (1: no past-epoch limits)
        w.u32(u16::from(self.suite) as u32);
        let basic = BasicCredential::try_from(self.credential.credential.clone()).map_err(lib)?;
        w.bytes(basic.identity());
        w.bytes(self.signer.public());
        w.u32(self.groups.len() as u32);
        for id in self.groups.keys() {
            w.bytes(id);
        }
        let values = self.provider.storage().values.read().map_err(|_| adapter("storage lock"))?;
        w.u32(values.len() as u32);
        let mut entries: Vec<_> = values.iter().collect();
        entries.sort();
        for (k, v) in entries {
            w.bytes(k);
            w.bytes(v);
        }
        drop(values);
        // Format 2 appends the past-epoch limit the adapter set per group, so an imported device
        // keeps it. Appended last: the format-1 layout stays a prefix (hoptell's lib/mls/openmls.js
        // reads the storage entries of an exported state).
        let mut limits: Vec<_> = self.limits.iter().filter(|(id, _)| self.groups.contains_key(*id)).collect();
        limits.sort();
        w.u32(limits.len() as u32);
        for (id, limit) in limits {
            w.bytes(id);
            w.u32(*limit as u32);
        }
        Ok(w.0)
    }

    /// A device from export_state(): a fresh provider filled with the stored entries, the signer
    /// read back from storage, every group loaded with MlsGroup::load.
    pub fn import_state(state: &[u8]) -> Result<Device, JsError> {
        let mut r = Reader(state);
        let format = r.take(1)?[0];
        if format != 1 && format != 2 {
            return Err(adapter("unknown state format"));
        }
        let suite = suite_from(r.u32()? as u16)?;
        let identity = BasicCredential::new(r.bytes()?.to_vec());
        let public = r.bytes()?.to_vec();
        let mut group_ids = Vec::new();
        for _ in 0..r.u32()? {
            group_ids.push(r.bytes()?.to_vec());
        }
        let provider = new_provider()?;
        {
            let mut values = provider.storage().values.write().map_err(|_| adapter("storage lock"))?;
            for _ in 0..r.u32()? {
                let k = r.bytes()?.to_vec();
                let v = r.bytes()?.to_vec();
                values.insert(k, v);
            }
        }
        let mut limits = HashMap::new();
        if format >= 2 {
            for _ in 0..r.u32()? {
                let id = r.bytes()?.to_vec();
                limits.insert(id, (r.u32()? as usize).min(MAX_PAST_EPOCHS));
            }
        }
        if !r.0.is_empty() {
            return Err(adapter("trailing bytes in state"));
        }
        let signer = SignatureKeyPair::read(provider.storage(), &public, suite.signature_algorithm())
            .ok_or_else(|| adapter("signer not in storage"))?;
        let credential = CredentialWithKey { credential: identity.into(), signature_key: public.into() };
        let mut device = Device::from_parts(provider, signer, credential, suite);
        for id in group_ids {
            let group = MlsGroup::load(device.provider.storage(), &GroupId::from_slice(&id))
                .map_err(lib)?
                .ok_or_else(|| adapter("group not in storage"))?;
            device.groups.insert(id, group);
        }
        limits.retain(|id, _| device.groups.contains_key(id));
        device.limits = limits;
        Ok(device)
    }
}

/// A byte string inside a Vec crossing the boundary (Vec<Vec<u8>> is not supported directly).
pub mod js_value_bytes {
    use wasm_bindgen::prelude::*;
    #[wasm_bindgen(getter_with_clone)]
    #[derive(Clone)]
    pub struct Bytes {
        pub bytes: Vec<u8>,
    }
    #[wasm_bindgen]
    impl Bytes {
        #[wasm_bindgen(constructor)]
        pub fn new(bytes: Vec<u8>) -> Bytes {
            Bytes { bytes }
        }
    }
}

struct Writer(Vec<u8>);
impl Writer {
    fn u32(&mut self, v: u32) {
        self.0.extend_from_slice(&v.to_be_bytes());
    }
    fn bytes(&mut self, b: &[u8]) {
        self.u32(b.len() as u32);
        self.0.extend_from_slice(b);
    }
}

struct Reader<'a>(&'a [u8]);
impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], JsError> {
        if self.0.len() < n {
            return Err(adapter("truncated state"));
        }
        let (head, rest) = self.0.split_at(n);
        self.0 = rest;
        Ok(head)
    }
    fn u32(&mut self) -> Result<u32, JsError> {
        Ok(u32::from_be_bytes(self.take(4)?.try_into().map_err(|_| adapter("truncated state"))?))
    }
    fn bytes(&mut self) -> Result<&'a [u8], JsError> {
        let n = self.u32()? as usize;
        self.take(n)
    }
}

/// Test-only AEAD instrumentation (feature aead-trace, gate 5 HV2-4): every AEAD seal OpenMLS makes
/// is recorded as fingerprints of the actual key and the actual nonce (HMAC-SHA-256 under a
/// per-run key the test sets, truncated to 8 bytes: comparable within a run, not invertible) and
/// the SHA-256 of the sealed output (ct || tag), so a published PrivateMessage links to the key
/// and nonce that sealed it. With the reuse fault on, every content seal after the first reuses
/// the first one's key and nonce (the negative control; counters are untouched).
#[cfg(feature = "aead-trace")]
mod aead_trace {
    use openmls_libcrux_crypto::{CryptoProvider, Provider};
    use openmls_traits::crypto::OpenMlsCrypto;
    use openmls_traits::types::*;
    use openmls_traits::OpenMlsProvider;
    use std::sync::Mutex;
    use openmls::prelude::tls_codec::SecretVLBytes;

    pub struct Seal {
        pub kind: &'static str,
        pub key_fp: Vec<u8>,
        pub nonce_fp: Vec<u8>,
        pub out_sha256: Vec<u8>,
    }
    struct State {
        run_key: Option<Vec<u8>>,
        reuse: bool,
        first: Option<(Vec<u8>, Vec<u8>)>,
        seals: Vec<Seal>,
    }
    static STATE: Mutex<State> = Mutex::new(State { run_key: None, reuse: false, first: None, seals: Vec::new() });

    pub fn start(run_key: Vec<u8>, reuse: bool) {
        let mut st = STATE.lock().unwrap();
        st.run_key = Some(run_key);
        st.reuse = reuse;
        st.first = None;
        st.seals.clear();
    }
    pub fn take() -> Vec<Seal> {
        std::mem::take(&mut STATE.lock().unwrap().seals)
    }

    pub struct TracingCrypto(CryptoProvider);

    impl TracingCrypto {
        fn fp(&self, run_key: &[u8], label: &[u8], v: &[u8]) -> Vec<u8> {
            let mut m = label.to_vec();
            m.extend_from_slice(v);
            self.0.hmac(HashType::Sha2_256, run_key, &m).map(|t| t.as_slice()[..8].to_vec()).unwrap_or_default()
        }
    }

    impl OpenMlsCrypto for TracingCrypto {
        fn supports(&self, c: Ciphersuite) -> Result<(), CryptoError> {
            self.0.supports(c)
        }
        fn supported_ciphersuites(&self) -> Vec<Ciphersuite> {
            self.0.supported_ciphersuites()
        }
        fn hkdf_extract(&self, h: HashType, salt: &[u8], ikm: &[u8]) -> Result<SecretVLBytes, CryptoError> {
            self.0.hkdf_extract(h, salt, ikm)
        }
        fn hmac(&self, h: HashType, key: &[u8], message: &[u8]) -> Result<SecretVLBytes, CryptoError> {
            self.0.hmac(h, key, message)
        }
        fn hkdf_expand(&self, h: HashType, prk: &[u8], info: &[u8], okm_len: usize) -> Result<SecretVLBytes, CryptoError> {
            self.0.hkdf_expand(h, prk, info, okm_len)
        }
        fn hash(&self, h: HashType, data: &[u8]) -> Result<Vec<u8>, CryptoError> {
            self.0.hash(h, data)
        }
        fn aead_encrypt(&self, alg: AeadType, key: &[u8], data: &[u8], nonce: &[u8], aad: &[u8]) -> Result<Vec<u8>, CryptoError> {
            // SenderData is 12 bytes (leaf index, generation, reuse guard); content is longer.
            let kind = if data.len() == 12 { "sender-data" } else { "content" };
            let (key, nonce) = {
                let mut st = STATE.lock().unwrap();
                if st.reuse && kind == "content" {
                    match &st.first {
                        Some((k, n)) if k.len() == key.len() && n.len() == nonce.len() => (k.clone(), n.clone()),
                        _ => {
                            st.first = Some((key.to_vec(), nonce.to_vec()));
                            (key.to_vec(), nonce.to_vec())
                        }
                    }
                } else {
                    (key.to_vec(), nonce.to_vec())
                }
            };
            let out = self.0.aead_encrypt(alg, &key, data, &nonce, aad)?;
            let run_key = STATE.lock().unwrap().run_key.clone();
            if let Some(rk) = run_key {
                let seal = Seal {
                    kind,
                    key_fp: self.fp(&rk, b"key", &key),
                    nonce_fp: self.fp(&rk, b"nonce", &nonce),
                    out_sha256: self.0.hash(HashType::Sha2_256, &out)?,
                };
                STATE.lock().unwrap().seals.push(seal);
            }
            Ok(out)
        }
        fn aead_decrypt(&self, alg: AeadType, key: &[u8], ct_tag: &[u8], nonce: &[u8], aad: &[u8]) -> Result<Vec<u8>, CryptoError> {
            self.0.aead_decrypt(alg, key, ct_tag, nonce, aad)
        }
        fn signature_key_gen(&self, alg: SignatureScheme) -> Result<(Vec<u8>, Vec<u8>), CryptoError> {
            self.0.signature_key_gen(alg)
        }
        fn verify_signature(&self, alg: SignatureScheme, data: &[u8], pk: &[u8], signature: &[u8]) -> Result<(), CryptoError> {
            self.0.verify_signature(alg, data, pk, signature)
        }
        fn sign(&self, alg: SignatureScheme, data: &[u8], key: &[u8]) -> Result<Vec<u8>, CryptoError> {
            self.0.sign(alg, data, key)
        }
        fn hpke_seal(&self, config: HpkeConfig, pk_r: &[u8], info: &[u8], aad: &[u8], ptxt: &[u8]) -> Result<HpkeCiphertext, CryptoError> {
            self.0.hpke_seal(config, pk_r, info, aad, ptxt)
        }
        fn hpke_open(&self, config: HpkeConfig, input: &HpkeCiphertext, sk_r: &[u8], info: &[u8], aad: &[u8]) -> Result<Vec<u8>, CryptoError> {
            self.0.hpke_open(config, input, sk_r, info, aad)
        }
        fn hpke_setup_sender_and_export(&self, config: HpkeConfig, pk_r: &[u8], info: &[u8], exporter_context: &[u8], exporter_length: usize) -> Result<(KemOutput, ExporterSecret), CryptoError> {
            self.0.hpke_setup_sender_and_export(config, pk_r, info, exporter_context, exporter_length)
        }
        fn hpke_setup_receiver_and_export(&self, config: HpkeConfig, enc: &[u8], sk_r: &[u8], info: &[u8], exporter_context: &[u8], exporter_length: usize) -> Result<ExporterSecret, CryptoError> {
            self.0.hpke_setup_receiver_and_export(config, enc, sk_r, info, exporter_context, exporter_length)
        }
        fn derive_hpke_keypair(&self, config: HpkeConfig, ikm: &[u8]) -> Result<HpkeKeyPair, CryptoError> {
            self.0.derive_hpke_keypair(config, ikm)
        }
    }

    /// libcrux + MemoryStorage as in production, with the crypto wrapped.
    pub struct TracingProvider {
        inner: Provider,
        crypto: TracingCrypto,
    }
    impl TracingProvider {
        pub fn new() -> Result<Self, CryptoError> {
            Ok(TracingProvider { inner: Provider::new()?, crypto: TracingCrypto(CryptoProvider::new()?) })
        }
    }
    impl OpenMlsProvider for TracingProvider {
        type CryptoProvider = TracingCrypto;
        type RandProvider = CryptoProvider;
        type StorageProvider = openmls_memory_storage::MemoryStorage;
        fn storage(&self) -> &Self::StorageProvider {
            self.inner.storage()
        }
        fn crypto(&self) -> &Self::CryptoProvider {
            &self.crypto
        }
        fn rand(&self) -> &Self::RandProvider {
            self.inner.rand()
        }
    }
}

/// One fingerprinted AEAD seal (aead-trace builds): kind "content" | "sender-data", key and nonce
/// fingerprints (8 bytes each), SHA-256 of the sealed output.
#[wasm_bindgen(getter_with_clone)]
pub struct AeadSeal {
    pub kind: String,
    pub key_fp: Vec<u8>,
    pub nonce_fp: Vec<u8>,
    pub out_sha256: Vec<u8>,
}

/// Whether this build has the test-only AEAD instrumentation.
#[wasm_bindgen]
pub fn aead_trace_available() -> bool {
    cfg!(feature = "aead-trace")
}

/// Start recording AEAD seals with this run's fingerprint key; `reuse` turns on the negative
/// control (content seals reuse the first key and nonce).
#[wasm_bindgen]
pub fn aead_trace_start(run_key: Vec<u8>, reuse: bool) -> Result<(), JsError> {
    #[cfg(feature = "aead-trace")]
    {
        aead_trace::start(run_key, reuse);
        Ok(())
    }
    #[cfg(not(feature = "aead-trace"))]
    {
        let _ = (run_key, reuse);
        Err(adapter("this build has no AEAD instrumentation (build pkg-trace)"))
    }
}

/// The seals recorded since the last call.
#[wasm_bindgen]
pub fn aead_trace_take() -> Result<Vec<AeadSeal>, JsError> {
    #[cfg(feature = "aead-trace")]
    {
        Ok(aead_trace::take().into_iter().map(|s| AeadSeal { kind: s.kind.into(), key_fp: s.key_fp, nonce_fp: s.nonce_fp, out_sha256: s.out_sha256 }).collect())
    }
    #[cfg(not(feature = "aead-trace"))]
    {
        Err(adapter("this build has no AEAD instrumentation (build pkg-trace)"))
    }
}
