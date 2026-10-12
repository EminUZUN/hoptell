if (typeof globalThis.crypto === "undefined") globalThis.crypto = require("node:crypto").webcrypto;
let wasm_bindgen = (function(exports) {
    let script_src;
    if (typeof document !== 'undefined' && document.currentScript !== null) {
        script_src = new URL(document.currentScript.src, location.href).toString();
    }

    /**
     * One fingerprinted AEAD seal (aead-trace builds): kind "content" | "sender-data", key and nonce
     * fingerprints (8 bytes each), SHA-256 of the sealed output.
     */
    class AeadSeal {
        __destroy_into_raw() {
            const ptr = this.__wbg_ptr;
            this.__wbg_ptr = 0;
            AeadSealFinalization.unregister(this);
            return ptr;
        }
        free() {
            const ptr = this.__destroy_into_raw();
            wasm.__wbg_aeadseal_free(ptr, 0);
        }
        /**
         * @returns {Uint8Array}
         */
        get key_fp() {
            const ret = wasm.__wbg_get_aeadseal_key_fp(this.__wbg_ptr);
            var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
            return v1;
        }
        /**
         * @returns {string}
         */
        get kind() {
            let deferred1_0;
            let deferred1_1;
            try {
                const ret = wasm.__wbg_get_aeadseal_kind(this.__wbg_ptr);
                deferred1_0 = ret[0];
                deferred1_1 = ret[1];
                return getStringFromWasm0(ret[0], ret[1]);
            } finally {
                wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
            }
        }
        /**
         * @returns {Uint8Array}
         */
        get nonce_fp() {
            const ret = wasm.__wbg_get_aeadseal_nonce_fp(this.__wbg_ptr);
            var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
            return v1;
        }
        /**
         * @returns {Uint8Array}
         */
        get out_sha256() {
            const ret = wasm.__wbg_get_aeadseal_out_sha256(this.__wbg_ptr);
            var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
            return v1;
        }
        /**
         * @param {Uint8Array} arg0
         */
        set key_fp(arg0) {
            const ptr0 = passArray8ToWasm0(arg0, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            wasm.__wbg_set_aeadseal_key_fp(this.__wbg_ptr, ptr0, len0);
        }
        /**
         * @param {string} arg0
         */
        set kind(arg0) {
            const ptr0 = passStringToWasm0(arg0, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            wasm.__wbg_set_aeadseal_kind(this.__wbg_ptr, ptr0, len0);
        }
        /**
         * @param {Uint8Array} arg0
         */
        set nonce_fp(arg0) {
            const ptr0 = passArray8ToWasm0(arg0, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            wasm.__wbg_set_aeadseal_nonce_fp(this.__wbg_ptr, ptr0, len0);
        }
        /**
         * @param {Uint8Array} arg0
         */
        set out_sha256(arg0) {
            const ptr0 = passArray8ToWasm0(arg0, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            wasm.__wbg_set_aeadseal_out_sha256(this.__wbg_ptr, ptr0, len0);
        }
    }
    if (Symbol.dispose) AeadSeal.prototype[Symbol.dispose] = AeadSeal.prototype.free;
    exports.AeadSeal = AeadSeal;

    class Bytes {
        static __wrap(ptr) {
            const obj = Object.create(Bytes.prototype);
            obj.__wbg_ptr = ptr;
            BytesFinalization.register(obj, obj.__wbg_ptr, obj);
            return obj;
        }
        static __unwrap(jsValue) {
            if (!(jsValue instanceof Bytes)) {
                return 0;
            }
            return jsValue.__destroy_into_raw();
        }
        __destroy_into_raw() {
            const ptr = this.__wbg_ptr;
            this.__wbg_ptr = 0;
            BytesFinalization.unregister(this);
            return ptr;
        }
        free() {
            const ptr = this.__destroy_into_raw();
            wasm.__wbg_bytes_free(ptr, 0);
        }
        /**
         * @param {Uint8Array} bytes
         */
        constructor(bytes) {
            const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.bytes_new(ptr0, len0);
            this.__wbg_ptr = ret;
            BytesFinalization.register(this, this.__wbg_ptr, this);
            return this;
        }
        /**
         * @returns {Uint8Array}
         */
        get bytes() {
            const ret = wasm.__wbg_get_bytes_bytes(this.__wbg_ptr);
            var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
            return v1;
        }
        /**
         * @param {Uint8Array} arg0
         */
        set bytes(arg0) {
            const ptr0 = passArray8ToWasm0(arg0, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            wasm.__wbg_set_bytes_bytes(this.__wbg_ptr, ptr0, len0);
        }
    }
    if (Symbol.dispose) Bytes.prototype[Symbol.dispose] = Bytes.prototype.free;
    exports.Bytes = Bytes;

    /**
     * The outcome of an own commit: commit (MLSMessage), Welcome (MLSMessage, empty when none),
     * the ratchet tree of the new epoch (for joiners).
     */
    class CommitOut {
        static __wrap(ptr) {
            const obj = Object.create(CommitOut.prototype);
            obj.__wbg_ptr = ptr;
            CommitOutFinalization.register(obj, obj.__wbg_ptr, obj);
            return obj;
        }
        __destroy_into_raw() {
            const ptr = this.__wbg_ptr;
            this.__wbg_ptr = 0;
            CommitOutFinalization.unregister(this);
            return ptr;
        }
        free() {
            const ptr = this.__destroy_into_raw();
            wasm.__wbg_commitout_free(ptr, 0);
        }
        /**
         * @returns {Uint8Array}
         */
        get commit() {
            const ret = wasm.__wbg_get_commitout_commit(this.__wbg_ptr);
            var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
            return v1;
        }
        /**
         * @returns {Uint8Array}
         */
        get ratchet_tree() {
            const ret = wasm.__wbg_get_commitout_ratchet_tree(this.__wbg_ptr);
            var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
            return v1;
        }
        /**
         * @returns {Uint8Array}
         */
        get welcome() {
            const ret = wasm.__wbg_get_commitout_welcome(this.__wbg_ptr);
            var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
            return v1;
        }
        /**
         * @param {Uint8Array} arg0
         */
        set commit(arg0) {
            const ptr0 = passArray8ToWasm0(arg0, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            wasm.__wbg_set_commitout_commit(this.__wbg_ptr, ptr0, len0);
        }
        /**
         * @param {Uint8Array} arg0
         */
        set ratchet_tree(arg0) {
            const ptr0 = passArray8ToWasm0(arg0, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            wasm.__wbg_set_commitout_ratchet_tree(this.__wbg_ptr, ptr0, len0);
        }
        /**
         * @param {Uint8Array} arg0
         */
        set welcome(arg0) {
            const ptr0 = passArray8ToWasm0(arg0, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            wasm.__wbg_set_commitout_welcome(this.__wbg_ptr, ptr0, len0);
        }
    }
    if (Symbol.dispose) CommitOut.prototype[Symbol.dispose] = CommitOut.prototype.free;
    exports.CommitOut = CommitOut;

    class Device {
        static __wrap(ptr) {
            const obj = Object.create(Device.prototype);
            obj.__wbg_ptr = ptr;
            DeviceFinalization.register(obj, obj.__wbg_ptr, obj);
            return obj;
        }
        __destroy_into_raw() {
            const ptr = this.__wbg_ptr;
            this.__wbg_ptr = 0;
            DeviceFinalization.unregister(this);
            return ptr;
        }
        free() {
            const ptr = this.__destroy_into_raw();
            wasm.__wbg_device_free(ptr, 0);
        }
        /**
         * @param {Uint8Array} group_id
         */
        clear_pending(group_id) {
            const ptr0 = passArray8ToWasm0(group_id, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.device_clear_pending(this.__wbg_ptr, ptr0, len0);
            if (ret[1]) {
                throw takeFromExternrefTable0(ret[0]);
            }
        }
        /**
         * An own commit, kept as the group's pending commit until merge_pending / clear_pending.
         * Key packages must have been checked (key_package_info + oracle) by the caller.
         * @param {Uint8Array} group_id
         * @param {Bytes[]} add
         * @param {Uint32Array} remove
         * @param {boolean} update
         * @returns {CommitOut}
         */
        commit(group_id, add, remove, update) {
            const ptr0 = passArray8ToWasm0(group_id, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArrayJsValueToWasm0(add, wasm.__wbindgen_malloc);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passArray32ToWasm0(remove, wasm.__wbindgen_malloc);
            const len2 = WASM_VECTOR_LEN;
            const ret = wasm.device_commit(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, update);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return CommitOut.__wrap(ret[0]);
        }
        /**
         * A new group. With required extension or proposal types, the group context carries a
         * required_capabilities extension with them, and the creator's own leaf advertises them.
         * @param {Uint8Array} group_id
         * @param {Uint16Array | null} [required_extensions]
         * @param {Uint16Array | null} [required_proposals]
         */
        create_group(group_id, required_extensions, required_proposals) {
            const ptr0 = passArray8ToWasm0(group_id, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            var ptr1 = isLikeNone(required_extensions) ? 0 : passArray16ToWasm0(required_extensions, wasm.__wbindgen_malloc);
            var len1 = WASM_VECTOR_LEN;
            var ptr2 = isLikeNone(required_proposals) ? 0 : passArray16ToWasm0(required_proposals, wasm.__wbindgen_malloc);
            var len2 = WASM_VECTOR_LEN;
            const ret = wasm.device_create_group(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
            if (ret[1]) {
                throw takeFromExternrefTable0(ret[0]);
            }
        }
        /**
         * Drop a staged commit (another commit won). The consumed generation stays consumed.
         * @param {number} handle
         */
        discard_staged(handle) {
            const ret = wasm.device_discard_staged(this.__wbg_ptr, handle);
            if (ret[1]) {
                throw takeFromExternrefTable0(ret[0]);
            }
        }
        /**
         * An application message (PrivateMessage) with the given AAD.
         * @param {Uint8Array} group_id
         * @param {Uint8Array} plaintext
         * @param {Uint8Array} aad
         * @returns {Uint8Array}
         */
        encrypt(group_id, plaintext, aad) {
            const ptr0 = passArray8ToWasm0(group_id, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArray8ToWasm0(plaintext, wasm.__wbindgen_malloc);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passArray8ToWasm0(aad, wasm.__wbindgen_malloc);
            const len2 = WASM_VECTOR_LEN;
            const ret = wasm.device_encrypt(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
            if (ret[3]) {
                throw takeFromExternrefTable0(ret[2]);
            }
            var v4 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
            return v4;
        }
        /**
         * @param {Uint8Array} group_id
         * @returns {bigint}
         */
        epoch(group_id) {
            const ptr0 = passArray8ToWasm0(group_id, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.device_epoch(this.__wbg_ptr, ptr0, len0);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return BigInt.asUintN(64, ret[0]);
        }
        /**
         * @param {Uint8Array} group_id
         * @returns {Uint8Array}
         */
        epoch_authenticator(group_id) {
            const ptr0 = passArray8ToWasm0(group_id, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.device_epoch_authenticator(this.__wbg_ptr, ptr0, len0);
            if (ret[3]) {
                throw takeFromExternrefTable0(ret[2]);
            }
            var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
            return v2;
        }
        /**
         * The whole device: suite, identity, signature public key, group ids, the past-epoch limit
         * set per group, and every entry of the provider's MemoryStorage (which holds the signer's private key, KeyPackage private
         * keys, group state, secret tree, pending commit, proposals). Staged commits/Welcomes not
         * yet merged are in memory only and are not exported.
         * @returns {Uint8Array}
         */
        export_state() {
            const ret = wasm.device_export_state(this.__wbg_ptr);
            if (ret[3]) {
                throw takeFromExternrefTable0(ret[2]);
            }
            var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
            return v1;
        }
        /**
         * @returns {Bytes[]}
         */
        group_ids() {
            const ret = wasm.device_group_ids(this.__wbg_ptr);
            var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
            wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
            return v1;
        }
        /**
         * A signed GroupInfo of the current epoch (an MLSMessage) with the ratchet tree extension.
         * @param {Uint8Array} group_id
         * @returns {Uint8Array}
         */
        group_info(group_id) {
            const ptr0 = passArray8ToWasm0(group_id, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.device_group_info(this.__wbg_ptr, ptr0, len0);
            if (ret[3]) {
                throw takeFromExternrefTable0(ret[2]);
            }
            var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
            return v2;
        }
        /**
         * The skipped-key bounds stored with this group ([out-of-order tolerance, maximum forward
         * distance]): skip_limits() for a group this build created or joined; a group created or
         * joined by an earlier build keeps the bounds it was made with (OpenMLS stores them with the
         * group), so the caller can tell (amendment A6). Read-only.
         * @param {Uint8Array} group_id
         * @returns {Uint32Array}
         */
        group_skip_limits(group_id) {
            const ptr0 = passArray8ToWasm0(group_id, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.device_group_skip_limits(this.__wbg_ptr, ptr0, len0);
            if (ret[3]) {
                throw takeFromExternrefTable0(ret[2]);
            }
            var v2 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
            return v2;
        }
        /**
         * A device from export_state(): a fresh provider filled with the stored entries, the signer
         * read back from storage, every group loaded with MlsGroup::load.
         * @param {Uint8Array} state
         * @returns {Device}
         */
        static import_state(state) {
            const ptr0 = passArray8ToWasm0(state, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.device_import_state(ptr0, len0);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return Device.__wrap(ret[0]);
        }
        /**
         * @param {Uint8Array} group_id
         * @returns {boolean}
         */
        is_active(group_id) {
            const ptr0 = passArray8ToWasm0(group_id, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.device_is_active(this.__wbg_ptr, ptr0, len0);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return ret[0] !== 0;
        }
        /**
         * @param {number} handle
         */
        join_discard(handle) {
            const ret = wasm.device_join_discard(this.__wbg_ptr, handle);
            if (ret[1]) {
                throw takeFromExternrefTable0(ret[0]);
            }
        }
        /**
         * @param {number} handle
         * @returns {Uint8Array}
         */
        join_finish(handle) {
            const ret = wasm.device_join_finish(this.__wbg_ptr, handle);
            if (ret[3]) {
                throw takeFromExternrefTable0(ret[2]);
            }
            var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
            return v1;
        }
        /**
         * Stage a Welcome (with the ratchet tree when it is not in the Welcome). Nothing is joined
         * until join_finish; join_discard restores the storage (the KeyPackage private key).
         * @param {Uint8Array} welcome
         * @param {Uint8Array | null} [ratchet_tree]
         * @returns {WelcomeOut}
         */
        join_stage(welcome, ratchet_tree) {
            const ptr0 = passArray8ToWasm0(welcome, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            var ptr1 = isLikeNone(ratchet_tree) ? 0 : passArray8ToWasm0(ratchet_tree, wasm.__wbindgen_malloc);
            var len1 = WASM_VECTOR_LEN;
            const ret = wasm.device_join_stage(this.__wbg_ptr, ptr0, len0, ptr1, len1);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return WelcomeOut.__wrap(ret[0]);
        }
        /**
         * A KeyPackage as an MLSMessage; its private part is stored in the provider. The leaf
         * capabilities' extension, proposal and credential type lists replace the defaults when
         * given.
         * @param {number | null} [lifetime_seconds]
         * @param {Uint16Array | null} [extensions]
         * @param {Uint16Array | null} [proposals]
         * @param {Uint16Array | null} [credentials]
         * @returns {Uint8Array}
         */
        key_package(lifetime_seconds, extensions, proposals, credentials) {
            var ptr0 = isLikeNone(extensions) ? 0 : passArray16ToWasm0(extensions, wasm.__wbindgen_malloc);
            var len0 = WASM_VECTOR_LEN;
            var ptr1 = isLikeNone(proposals) ? 0 : passArray16ToWasm0(proposals, wasm.__wbindgen_malloc);
            var len1 = WASM_VECTOR_LEN;
            var ptr2 = isLikeNone(credentials) ? 0 : passArray16ToWasm0(credentials, wasm.__wbindgen_malloc);
            var len2 = WASM_VECTOR_LEN;
            const ret = wasm.device_key_package(this.__wbg_ptr, isLikeNone(lifetime_seconds) ? Number.MAX_SAFE_INTEGER : (lifetime_seconds) >>> 0, ptr0, len0, ptr1, len1, ptr2, len2);
            if (ret[3]) {
                throw takeFromExternrefTable0(ret[2]);
            }
            var v4 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
            return v4;
        }
        /**
         * Validate a KeyPackage (signatures, version, suite: the library's part) and return its
         * credential for the oracle.
         * @param {Uint8Array} key_package
         * @returns {LeafInfo}
         */
        key_package_info(key_package) {
            const ptr0 = passArray8ToWasm0(key_package, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.device_key_package_info(this.__wbg_ptr, ptr0, len0);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return LeafInfo.__wrap(ret[0]);
        }
        /**
         * @param {Uint8Array} group_id
         * @returns {LeafInfo[]}
         */
        members(group_id) {
            const ptr0 = passArray8ToWasm0(group_id, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.device_members(this.__wbg_ptr, ptr0, len0);
            if (ret[3]) {
                throw takeFromExternrefTable0(ret[2]);
            }
            var v2 = getArrayJsValueFromWasm0(ret[0], ret[1]);
            wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
            return v2;
        }
        /**
         * @param {Uint8Array} group_id
         */
        merge_pending(group_id) {
            const ptr0 = passArray8ToWasm0(group_id, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.device_merge_pending(this.__wbg_ptr, ptr0, len0);
            if (ret[1]) {
                throw takeFromExternrefTable0(ret[0]);
            }
        }
        /**
         * @param {number} handle
         */
        merge_staged(handle) {
            const ret = wasm.device_merge_staged(this.__wbg_ptr, handle);
            if (ret[1]) {
                throw takeFromExternrefTable0(ret[0]);
            }
        }
        /**
         * A new device: an Ed25519 key pair (stored in the provider) and a BasicCredential.
         * @param {number} suite
         * @param {Uint8Array} identity
         */
        constructor(suite, identity) {
            const ptr0 = passArray8ToWasm0(identity, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.device_new(suite, ptr0, len0);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            this.__wbg_ptr = ret[0];
            DeviceFinalization.register(this, this.__wbg_ptr, this);
            return this;
        }
        /**
         * @param {Uint8Array} group_id
         * @returns {number}
         */
        own_index(group_id) {
            const ptr0 = passArray8ToWasm0(group_id, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.device_own_index(this.__wbg_ptr, ptr0, len0);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return ret[0] >>> 0;
        }
        /**
         * The group's past-epoch limit: the one the adapter last set, else (a group created, joined
         * or imported since) the limit OpenMLS stored for it (MaxEpochs in states written before
         * the binding held the limit), else the minimum.
         * @param {Uint8Array} group_id
         * @returns {number}
         */
        past_epoch_limit(group_id) {
            const ptr0 = passArray8ToWasm0(group_id, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.device_past_epoch_limit(this.__wbg_ptr, ptr0, len0);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return ret[0] >>> 0;
        }
        /**
         * The past epochs whose message secrets the group holds, oldest first: the binding's record
         * (filled from storage when absent, so it equals past_epochs_stored).
         * @param {Uint8Array} group_id
         * @returns {BigUint64Array}
         */
        past_epochs(group_id) {
            const ptr0 = passArray8ToWasm0(group_id, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.device_past_epochs(this.__wbg_ptr, ptr0, len0);
            if (ret[3]) {
                throw takeFromExternrefTable0(ret[2]);
            }
            var v2 = getArrayU64FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
            return v2;
        }
        /**
         * The past epochs whose message secrets the group holds, oldest first (OpenMLS's order),
         * as stored: only the epoch numbers are parsed, every secret is skipped. Evidence (tests
         * compare it with past_epochs); the hot path uses the binding's record.
         * @param {Uint8Array} group_id
         * @returns {BigUint64Array}
         */
        past_epochs_stored(group_id) {
            const ptr0 = passArray8ToWasm0(group_id, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.device_past_epochs_stored(this.__wbg_ptr, ptr0, len0);
            if (ret[3]) {
                throw takeFromExternrefTable0(ret[2]);
            }
            var v2 = getArrayU64FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
            return v2;
        }
        /**
         * Process an incoming MLSMessage (PublicMessage or PrivateMessage). On any error the group
         * is put back as it was before (OpenMLS has already advanced the secret tree by then).
         * @param {Uint8Array} group_id
         * @param {Uint8Array} message
         * @returns {Processed}
         */
        process(group_id, message) {
            const ptr0 = passArray8ToWasm0(group_id, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArray8ToWasm0(message, wasm.__wbindgen_malloc);
            const len1 = WASM_VECTOR_LEN;
            const ret = wasm.device_process(this.__wbg_ptr, ptr0, len0, ptr1, len1);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return Processed.__wrap(ret[0]);
        }
        /**
         * Delete the private parts of expired KeyPackages (amendment A10, checklist row 3): every
         * KeyPackage bundle in storage (the KeyPackage, its init private key and its leaf node
         * private key, stored together under the package's KeyPackageRef) whose lifetime `not_after`
         * is earlier than `now_seconds - grace_seconds` is deleted; a package whose `not_after` is at
         * or after that point is never touched. Returns the KeyPackageRefs of the deleted packages,
         * sorted. A Welcome for a deleted package can no longer be processed (no key matches it).
         * The caller gives the time (hoptell's clock, so tests control it). On any error the storage
         * is put back as it was before the call and nothing is deleted.
         * @param {bigint} now_seconds
         * @param {bigint} grace_seconds
         * @returns {Bytes[]}
         */
        prune_key_packages(now_seconds, grace_seconds) {
            const ret = wasm.device_prune_key_packages(this.__wbg_ptr, now_seconds, grace_seconds);
            if (ret[3]) {
                throw takeFromExternrefTable0(ret[2]);
            }
            var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
            wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
            return v1;
        }
        /**
         * Drop a staged commit the application refused, and put the group back as it was before
         * processing it, as if it had never been received.
         * @param {number} handle
         */
        refuse_staged(handle) {
            const ret = wasm.device_refuse_staged(this.__wbg_ptr, handle);
            if (ret[1]) {
                throw takeFromExternrefTable0(ret[0]);
            }
        }
        /**
         * Evidence only: OpenMLS's own runtime limit change, MlsGroup::set_configuration with a
         * join config whose max_past_epochs is `limit` (no workaround).
         * @param {Uint8Array} group_id
         * @param {number} limit
         */
        set_configuration_raw(group_id, limit) {
            const ptr0 = passArray8ToWasm0(group_id, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.device_set_configuration_raw(this.__wbg_ptr, ptr0, len0, limit);
            if (ret[1]) {
                throw takeFromExternrefTable0(ret[0]);
            }
        }
        /**
         * Set the group's past-epoch limit to `limit` (at most MAX_PAST_EPOCHS), deleting the oldest
         * past epochs beyond it.
         * Deletion is delete_past_epoch_secrets(max_past_epochs(limit)), which drops the oldest and
         * keeps the order (OpenMLS's own resize, set_configuration or a smaller MaxEpochs, drops the
         * wrong epochs when the store is not full: probes/openmls-resize.mjs). A limit at or above
         * the epochs held writes nothing, so this costs nothing when no epoch expires (it runs
         * before every process).
         * @param {Uint8Array} group_id
         * @param {number} limit
         */
        set_past_epoch_limit(group_id, limit) {
            const ptr0 = passArray8ToWasm0(group_id, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.device_set_past_epoch_limit(this.__wbg_ptr, ptr0, len0, limit);
            if (ret[1]) {
                throw takeFromExternrefTable0(ret[0]);
            }
        }
        /**
         * SignWithLabel (RFC 9420 section 5.1.2) with this device's signature key, for hoptell's own
         * statements (rotation, revocation: amendment A3). Only labels in hoptell's namespace are
         * signed (see APP_LABEL_PREFIX); the key itself never leaves the binding.
         * @param {string} label
         * @param {Uint8Array} content
         * @returns {Uint8Array}
         */
        sign_with_label(label, content) {
            const ptr0 = passStringToWasm0(label, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArray8ToWasm0(content, wasm.__wbindgen_malloc);
            const len1 = WASM_VECTOR_LEN;
            const ret = wasm.device_sign_with_label(this.__wbg_ptr, ptr0, len0, ptr1, len1);
            if (ret[3]) {
                throw takeFromExternrefTable0(ret[2]);
            }
            var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
            return v3;
        }
        /**
         * @returns {Uint8Array}
         */
        signature_public_key() {
            const ret = wasm.device_signature_public_key(this.__wbg_ptr);
            var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
            return v1;
        }
        /**
         * @returns {number}
         */
        suite() {
            const ret = wasm.device_suite(this.__wbg_ptr);
            return ret;
        }
        /**
         * Decrypt the sender data of a PrivateMessage of this group (sent or received) with the
         * sender-data secret of its epoch, read from storage (current epoch or a retained past
         * one). Changes nothing; returns no secret material.
         * @param {Uint8Array} group_id
         * @param {Uint8Array} message
         * @returns {TraceOut}
         */
        trace(group_id, message) {
            const ptr0 = passArray8ToWasm0(group_id, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArray8ToWasm0(message, wasm.__wbindgen_malloc);
            const len1 = WASM_VECTOR_LEN;
            const ret = wasm.device_trace(this.__wbg_ptr, ptr0, len0, ptr1, len1);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return TraceOut.__wrap(ret[0]);
        }
    }
    if (Symbol.dispose) Device.prototype[Symbol.dispose] = Device.prototype.free;
    exports.Device = Device;

    /**
     * A credential to validate, or a member: leaf index (u32::MAX when not in a tree yet),
     * BasicCredential identity, signature public key.
     */
    class LeafInfo {
        static __wrap(ptr) {
            const obj = Object.create(LeafInfo.prototype);
            obj.__wbg_ptr = ptr;
            LeafInfoFinalization.register(obj, obj.__wbg_ptr, obj);
            return obj;
        }
        static __unwrap(jsValue) {
            if (!(jsValue instanceof LeafInfo)) {
                return 0;
            }
            return jsValue.__destroy_into_raw();
        }
        __destroy_into_raw() {
            const ptr = this.__wbg_ptr;
            this.__wbg_ptr = 0;
            LeafInfoFinalization.unregister(this);
            return ptr;
        }
        free() {
            const ptr = this.__destroy_into_raw();
            wasm.__wbg_leafinfo_free(ptr, 0);
        }
        /**
         * @returns {Uint8Array}
         */
        get identity() {
            const ret = wasm.__wbg_get_leafinfo_identity(this.__wbg_ptr);
            var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
            return v1;
        }
        /**
         * @returns {number}
         */
        get index() {
            const ret = wasm.__wbg_get_leafinfo_index(this.__wbg_ptr);
            return ret >>> 0;
        }
        /**
         * @returns {Uint8Array}
         */
        get signature_key() {
            const ret = wasm.__wbg_get_leafinfo_signature_key(this.__wbg_ptr);
            var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
            return v1;
        }
        /**
         * @param {Uint8Array} arg0
         */
        set identity(arg0) {
            const ptr0 = passArray8ToWasm0(arg0, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            wasm.__wbg_set_leafinfo_identity(this.__wbg_ptr, ptr0, len0);
        }
        /**
         * @param {number} arg0
         */
        set index(arg0) {
            wasm.__wbg_set_leafinfo_index(this.__wbg_ptr, arg0);
        }
        /**
         * @param {Uint8Array} arg0
         */
        set signature_key(arg0) {
            const ptr0 = passArray8ToWasm0(arg0, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            wasm.__wbg_set_leafinfo_signature_key(this.__wbg_ptr, ptr0, len0);
        }
    }
    if (Symbol.dispose) LeafInfo.prototype[Symbol.dispose] = LeafInfo.prototype.free;
    exports.LeafInfo = LeafInfo;

    /**
     * The outcome of process(). kind is "application" | "commit" (a standalone proposal is refused:
     * amendment A7).
     * For "commit", `staged` is a handle for merge_staged / discard_staged, and `to_validate`
     * lists the credentials the commit brings in (committer, update path leaf, added and updated
     * leaves) for the application to check before merging.
     */
    class Processed {
        static __wrap(ptr) {
            const obj = Object.create(Processed.prototype);
            obj.__wbg_ptr = ptr;
            ProcessedFinalization.register(obj, obj.__wbg_ptr, obj);
            return obj;
        }
        __destroy_into_raw() {
            const ptr = this.__wbg_ptr;
            this.__wbg_ptr = 0;
            ProcessedFinalization.unregister(this);
            return ptr;
        }
        free() {
            const ptr = this.__destroy_into_raw();
            wasm.__wbg_processed_free(ptr, 0);
        }
        /**
         * @returns {Uint8Array}
         */
        get aad() {
            const ret = wasm.__wbg_get_processed_aad(this.__wbg_ptr);
            var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
            return v1;
        }
        /**
         * @returns {LeafInfo[]}
         */
        get added() {
            const ret = wasm.__wbg_get_processed_added(this.__wbg_ptr);
            var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
            wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
            return v1;
        }
        /**
         * @returns {bigint}
         */
        get epoch() {
            const ret = wasm.__wbg_get_processed_epoch(this.__wbg_ptr);
            return BigInt.asUintN(64, ret);
        }
        /**
         * @returns {string}
         */
        get kind() {
            let deferred1_0;
            let deferred1_1;
            try {
                const ret = wasm.__wbg_get_processed_kind(this.__wbg_ptr);
                deferred1_0 = ret[0];
                deferred1_1 = ret[1];
                return getStringFromWasm0(ret[0], ret[1]);
            } finally {
                wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
            }
        }
        /**
         * @returns {bigint}
         */
        get new_epoch() {
            const ret = wasm.__wbg_get_processed_new_epoch(this.__wbg_ptr);
            return BigInt.asUintN(64, ret);
        }
        /**
         * @returns {Uint8Array}
         */
        get plaintext() {
            const ret = wasm.__wbg_get_processed_plaintext(this.__wbg_ptr);
            var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
            return v1;
        }
        /**
         * @returns {Uint32Array}
         */
        get removed() {
            const ret = wasm.__wbg_get_processed_removed(this.__wbg_ptr);
            var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
            return v1;
        }
        /**
         * @returns {number}
         */
        get sender() {
            const ret = wasm.__wbg_get_processed_sender(this.__wbg_ptr);
            return ret >>> 0;
        }
        /**
         * @returns {number}
         */
        get staged() {
            const ret = wasm.__wbg_get_processed_staged(this.__wbg_ptr);
            return ret >>> 0;
        }
        /**
         * @returns {LeafInfo[]}
         */
        get to_validate() {
            const ret = wasm.__wbg_get_processed_to_validate(this.__wbg_ptr);
            var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
            wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
            return v1;
        }
        /**
         * @param {Uint8Array} arg0
         */
        set aad(arg0) {
            const ptr0 = passArray8ToWasm0(arg0, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            wasm.__wbg_set_processed_aad(this.__wbg_ptr, ptr0, len0);
        }
        /**
         * @param {LeafInfo[]} arg0
         */
        set added(arg0) {
            const ptr0 = passArrayJsValueToWasm0(arg0, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            wasm.__wbg_set_processed_added(this.__wbg_ptr, ptr0, len0);
        }
        /**
         * @param {bigint} arg0
         */
        set epoch(arg0) {
            wasm.__wbg_set_processed_epoch(this.__wbg_ptr, arg0);
        }
        /**
         * @param {string} arg0
         */
        set kind(arg0) {
            const ptr0 = passStringToWasm0(arg0, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            wasm.__wbg_set_processed_kind(this.__wbg_ptr, ptr0, len0);
        }
        /**
         * @param {bigint} arg0
         */
        set new_epoch(arg0) {
            wasm.__wbg_set_processed_new_epoch(this.__wbg_ptr, arg0);
        }
        /**
         * @param {Uint8Array} arg0
         */
        set plaintext(arg0) {
            const ptr0 = passArray8ToWasm0(arg0, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            wasm.__wbg_set_processed_plaintext(this.__wbg_ptr, ptr0, len0);
        }
        /**
         * @param {Uint32Array} arg0
         */
        set removed(arg0) {
            const ptr0 = passArray32ToWasm0(arg0, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            wasm.__wbg_set_processed_removed(this.__wbg_ptr, ptr0, len0);
        }
        /**
         * @param {number} arg0
         */
        set sender(arg0) {
            wasm.__wbg_set_processed_sender(this.__wbg_ptr, arg0);
        }
        /**
         * @param {number} arg0
         */
        set staged(arg0) {
            wasm.__wbg_set_processed_staged(this.__wbg_ptr, arg0);
        }
        /**
         * @param {LeafInfo[]} arg0
         */
        set to_validate(arg0) {
            const ptr0 = passArrayJsValueToWasm0(arg0, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            wasm.__wbg_set_processed_to_validate(this.__wbg_ptr, ptr0, len0);
        }
    }
    if (Symbol.dispose) Processed.prototype[Symbol.dispose] = Processed.prototype.free;
    exports.Processed = Processed;

    /**
     * The trace of a PrivateMessage: its sender data, decrypted read-only (RFC 9420 6.3.2).
     * content_type: 1 application, 2 proposal, 3 commit.
     */
    class TraceOut {
        static __wrap(ptr) {
            const obj = Object.create(TraceOut.prototype);
            obj.__wbg_ptr = ptr;
            TraceOutFinalization.register(obj, obj.__wbg_ptr, obj);
            return obj;
        }
        __destroy_into_raw() {
            const ptr = this.__wbg_ptr;
            this.__wbg_ptr = 0;
            TraceOutFinalization.unregister(this);
            return ptr;
        }
        free() {
            const ptr = this.__destroy_into_raw();
            wasm.__wbg_traceout_free(ptr, 0);
        }
        /**
         * @returns {number}
         */
        get content_type() {
            const ret = wasm.__wbg_get_traceout_content_type(this.__wbg_ptr);
            return ret;
        }
        /**
         * @returns {bigint}
         */
        get epoch() {
            const ret = wasm.__wbg_get_traceout_epoch(this.__wbg_ptr);
            return BigInt.asUintN(64, ret);
        }
        /**
         * @returns {number}
         */
        get generation() {
            const ret = wasm.__wbg_get_traceout_generation(this.__wbg_ptr);
            return ret >>> 0;
        }
        /**
         * @returns {Uint8Array}
         */
        get reuse_guard() {
            const ret = wasm.__wbg_get_traceout_reuse_guard(this.__wbg_ptr);
            var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
            return v1;
        }
        /**
         * @returns {number}
         */
        get sender() {
            const ret = wasm.__wbg_get_traceout_sender(this.__wbg_ptr);
            return ret >>> 0;
        }
        /**
         * @param {number} arg0
         */
        set content_type(arg0) {
            wasm.__wbg_set_traceout_content_type(this.__wbg_ptr, arg0);
        }
        /**
         * @param {bigint} arg0
         */
        set epoch(arg0) {
            wasm.__wbg_set_traceout_epoch(this.__wbg_ptr, arg0);
        }
        /**
         * @param {number} arg0
         */
        set generation(arg0) {
            wasm.__wbg_set_traceout_generation(this.__wbg_ptr, arg0);
        }
        /**
         * @param {Uint8Array} arg0
         */
        set reuse_guard(arg0) {
            const ptr0 = passArray8ToWasm0(arg0, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            wasm.__wbg_set_traceout_reuse_guard(this.__wbg_ptr, ptr0, len0);
        }
        /**
         * @param {number} arg0
         */
        set sender(arg0) {
            wasm.__wbg_set_traceout_sender(this.__wbg_ptr, arg0);
        }
    }
    if (Symbol.dispose) TraceOut.prototype[Symbol.dispose] = TraceOut.prototype.free;
    exports.TraceOut = TraceOut;

    /**
     * A staged Welcome: who is in the group before we accept it.
     */
    class WelcomeOut {
        static __wrap(ptr) {
            const obj = Object.create(WelcomeOut.prototype);
            obj.__wbg_ptr = ptr;
            WelcomeOutFinalization.register(obj, obj.__wbg_ptr, obj);
            return obj;
        }
        __destroy_into_raw() {
            const ptr = this.__wbg_ptr;
            this.__wbg_ptr = 0;
            WelcomeOutFinalization.unregister(this);
            return ptr;
        }
        free() {
            const ptr = this.__destroy_into_raw();
            wasm.__wbg_welcomeout_free(ptr, 0);
        }
        /**
         * @returns {Uint8Array}
         */
        get group_id() {
            const ret = wasm.__wbg_get_welcomeout_group_id(this.__wbg_ptr);
            var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
            return v1;
        }
        /**
         * @returns {number}
         */
        get handle() {
            const ret = wasm.__wbg_get_welcomeout_handle(this.__wbg_ptr);
            return ret >>> 0;
        }
        /**
         * @returns {LeafInfo[]}
         */
        get members() {
            const ret = wasm.__wbg_get_welcomeout_members(this.__wbg_ptr);
            var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
            wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
            return v1;
        }
        /**
         * @param {Uint8Array} arg0
         */
        set group_id(arg0) {
            const ptr0 = passArray8ToWasm0(arg0, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            wasm.__wbg_set_welcomeout_group_id(this.__wbg_ptr, ptr0, len0);
        }
        /**
         * @param {number} arg0
         */
        set handle(arg0) {
            wasm.__wbg_set_welcomeout_handle(this.__wbg_ptr, arg0);
        }
        /**
         * @param {LeafInfo[]} arg0
         */
        set members(arg0) {
            const ptr0 = passArrayJsValueToWasm0(arg0, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            wasm.__wbg_set_welcomeout_members(this.__wbg_ptr, ptr0, len0);
        }
    }
    if (Symbol.dispose) WelcomeOut.prototype[Symbol.dispose] = WelcomeOut.prototype.free;
    exports.WelcomeOut = WelcomeOut;

    /**
     * Whether this build has the test-only AEAD instrumentation.
     * @returns {boolean}
     */
    function aead_trace_available() {
        const ret = wasm.aead_trace_available();
        return ret !== 0;
    }
    exports.aead_trace_available = aead_trace_available;

    /**
     * Start recording AEAD seals with this run's fingerprint key; `reuse` turns on the negative
     * control (content seals reuse the first key and nonce).
     * @param {Uint8Array} run_key
     * @param {boolean} reuse
     */
    function aead_trace_start(run_key, reuse) {
        const ptr0 = passArray8ToWasm0(run_key, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.aead_trace_start(ptr0, len0, reuse);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    exports.aead_trace_start = aead_trace_start;

    /**
     * The seals recorded since the last call.
     * @returns {AeadSeal[]}
     */
    function aead_trace_take() {
        const ret = wasm.aead_trace_take();
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    exports.aead_trace_take = aead_trace_take;

    /**
     * Decode only (no signature verification): parse `bytes` as an MLSMessage with OpenMLS's own
     * tls_codec decoder (every nested structure and extension list, e.g. a GroupInfo's ratchet
     * tree extension), check the body is of `kind` ("MLSMessage" accepts any body), and describe it.
     * A Welcome's GroupInfo is encrypted and so cannot be decoded without the joiner's keys.
     * @param {string} kind
     * @param {Uint8Array} bytes
     * @returns {string}
     */
    function decode(kind, bytes) {
        let deferred4_0;
        let deferred4_1;
        try {
            const ptr0 = passStringToWasm0(kind, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
            const len1 = WASM_VECTOR_LEN;
            const ret = wasm.decode(ptr0, len0, ptr1, len1);
            var ptr3 = ret[0];
            var len3 = ret[1];
            if (ret[3]) {
                ptr3 = 0; len3 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred4_0 = ptr3;
            deferred4_1 = len3;
            return getStringFromWasm0(ptr3, len3);
        } finally {
            wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
        }
    }
    exports.decode = decode;

    /**
     * The group configuration this binding applies (stored by OpenMLS with each group, so it
     * survives export/import): past epochs kept, out-of-order tolerance, maximum forward distance,
     * and the cap on past epochs (DRIVER-V2 section 1).
     * @returns {Uint32Array}
     */
    function group_config() {
        const ret = wasm.group_config();
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    exports.group_config = group_config;

    /**
     * The skipped-key bounds this binding applies to every group it creates or joins:
     * [out-of-order tolerance (keys kept per sender per epoch), maximum forward distance]. hoptell's
     * contract test asserts they equal lib/mls/policy.js's (amendment A6).
     * @returns {Uint32Array}
     */
    function skip_limits() {
        const ret = wasm.skip_limits();
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    exports.skip_limits = skip_limits;

    /**
     * The cipher suites the libcrux provider supports as built (with the PQ draft feature).
     * @returns {Uint16Array}
     */
    function supported_suites() {
        const ret = wasm.supported_suites();
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU16FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 2, 2);
        return v1;
    }
    exports.supported_suites = supported_suites;

    /**
     * VerifyWithLabel (RFC 9420 section 5.1.2) of `signature` over (label, content) by the raw
     * signature public key `public_key`, with the suite's signature scheme (Ed25519 for the suites
     * hoptell uses). False for a wrong signature, key or content; an error for a refused label or an
     * unknown suite.
     * @param {number} suite
     * @param {Uint8Array} public_key
     * @param {string} label
     * @param {Uint8Array} content
     * @param {Uint8Array} signature
     * @returns {boolean}
     */
    function verify_with_label(suite, public_key, label, content, signature) {
        const ptr0 = passArray8ToWasm0(public_key, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(label, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray8ToWasm0(content, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArray8ToWasm0(signature, wasm.__wbindgen_malloc);
        const len3 = WASM_VECTOR_LEN;
        const ret = wasm.verify_with_label(suite, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    exports.verify_with_label = verify_with_label;
    function __wbg_get_imports() {
        const import0 = {
            __proto__: null,
            __wbg_Error_30c8987f7c2ed4e2: function(arg0, arg1) {
                const ret = Error(getStringFromWasm0(arg0, arg1));
                return ret;
            },
            __wbg___wbindgen_is_function_1f9d30630b8b1d3d: function(arg0) {
                const ret = typeof(arg0) === 'function';
                return ret;
            },
            __wbg___wbindgen_is_object_3c45d4f2dde4e749: function(arg0) {
                const val = arg0;
                const ret = typeof(val) === 'object' && val !== null;
                return ret;
            },
            __wbg___wbindgen_is_string_90b56bc79aad6f6c: function(arg0) {
                const ret = typeof(arg0) === 'string';
                return ret;
            },
            __wbg___wbindgen_is_undefined_8865fb403f8fe9d8: function(arg0) {
                const ret = arg0 === undefined;
                return ret;
            },
            __wbg___wbindgen_throw_41e9ee4f547fc59a: function(arg0, arg1) {
                throw new Error(getStringFromWasm0(arg0, arg1));
            },
            __wbg_bytes_new: function(arg0) {
                const ret = Bytes.__wrap(arg0);
                return ret;
            },
            __wbg_bytes_unwrap: function(arg0) {
                const ret = Bytes.__unwrap(arg0);
                return ret;
            },
            __wbg_call_187d372bd5fdd4aa: function() { return handleError(function (arg0, arg1, arg2) {
                const ret = arg0.call(arg1, arg2);
                return ret;
            }, arguments); },
            __wbg_crypto_38df2bab126b63dc: function(arg0) {
                const ret = arg0.crypto;
                return ret;
            },
            __wbg_getRandomValues_436a51d0629d84e1: function() { return handleError(function (arg0, arg1) {
                globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
            }, arguments); },
            __wbg_getRandomValues_c44a50d8cfdaebeb: function() { return handleError(function (arg0, arg1) {
                arg0.getRandomValues(arg1);
            }, arguments); },
            __wbg_leafinfo_new: function(arg0) {
                const ret = LeafInfo.__wrap(arg0);
                return ret;
            },
            __wbg_leafinfo_unwrap: function(arg0) {
                const ret = LeafInfo.__unwrap(arg0);
                return ret;
            },
            __wbg_length_7f3c00c40364105e: function(arg0) {
                const ret = arg0.length;
                return ret;
            },
            __wbg_msCrypto_bd5a034af96bcba6: function(arg0) {
                const ret = arg0.msCrypto;
                return ret;
            },
            __wbg_new_with_length_3da0ad195f6f63ba: function(arg0) {
                const ret = new Uint8Array(arg0 >>> 0);
                return ret;
            },
            __wbg_node_84ea875411254db1: function(arg0) {
                const ret = arg0.node;
                return ret;
            },
            __wbg_now_aa4ccb83129e9e55: function() {
                const ret = Date.now();
                return ret;
            },
            __wbg_process_44c7a14e11e9f69e: function(arg0) {
                const ret = arg0.process;
                return ret;
            },
            __wbg_prototypesetcall_bc27214492979395: function(arg0, arg1, arg2) {
                Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
            },
            __wbg_randomFillSync_6c25eac9869eb53c: function() { return handleError(function (arg0, arg1) {
                arg0.randomFillSync(arg1);
            }, arguments); },
            __wbg_require_b4edbdcf3e2a1ef0: function() { return handleError(function () {
                const ret = module.require;
                return ret;
            }, arguments); },
            __wbg_static_accessor_GLOBAL_266715b9d96ba635: function() {
                const ret = typeof global === 'undefined' ? null : global;
                return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
            },
            __wbg_static_accessor_GLOBAL_THIS_10fb7dc1ae063179: function() {
                const ret = typeof globalThis === 'undefined' ? null : globalThis;
                return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
            },
            __wbg_static_accessor_SELF_0b583911f537483a: function() {
                const ret = typeof self === 'undefined' ? null : self;
                return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
            },
            __wbg_static_accessor_WINDOW_d7f903d1508cbdc4: function() {
                const ret = typeof window === 'undefined' ? null : window;
                return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
            },
            __wbg_subarray_002b94d5e13d1411: function(arg0, arg1, arg2) {
                const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
                return ret;
            },
            __wbg_versions_276b2795b1c6a219: function(arg0) {
                const ret = arg0.versions;
                return ret;
            },
            __wbindgen_generic_0000000000000001: function(arg0, arg1) {
                // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
                const ret = getArrayU8FromWasm0(arg0, arg1);
                return ret;
            },
            __wbindgen_generic_0000000000000002: function(arg0, arg1) {
                // Cast intrinsic for `Ref(String) -> Externref`.
                const ret = getStringFromWasm0(arg0, arg1);
                return ret;
            },
            __wbindgen_init_externref_table: function() {
                const table = wasm.__wbindgen_externrefs;
                const offset = table.grow(4);
                table.set(0, undefined);
                table.set(offset + 0, undefined);
                table.set(offset + 1, null);
                table.set(offset + 2, true);
                table.set(offset + 3, false);
            },
        };
        return {
            __proto__: null,
            "./openmls_wasm_bg.js": import0,
        };
    }

    const AeadSealFinalization = (typeof FinalizationRegistry === 'undefined')
        ? { register: () => {}, unregister: () => {} }
        : new FinalizationRegistry(ptr => wasm.__wbg_aeadseal_free(ptr, 1));
    const BytesFinalization = (typeof FinalizationRegistry === 'undefined')
        ? { register: () => {}, unregister: () => {} }
        : new FinalizationRegistry(ptr => wasm.__wbg_bytes_free(ptr, 1));
    const CommitOutFinalization = (typeof FinalizationRegistry === 'undefined')
        ? { register: () => {}, unregister: () => {} }
        : new FinalizationRegistry(ptr => wasm.__wbg_commitout_free(ptr, 1));
    const DeviceFinalization = (typeof FinalizationRegistry === 'undefined')
        ? { register: () => {}, unregister: () => {} }
        : new FinalizationRegistry(ptr => wasm.__wbg_device_free(ptr, 1));
    const LeafInfoFinalization = (typeof FinalizationRegistry === 'undefined')
        ? { register: () => {}, unregister: () => {} }
        : new FinalizationRegistry(ptr => wasm.__wbg_leafinfo_free(ptr, 1));
    const ProcessedFinalization = (typeof FinalizationRegistry === 'undefined')
        ? { register: () => {}, unregister: () => {} }
        : new FinalizationRegistry(ptr => wasm.__wbg_processed_free(ptr, 1));
    const TraceOutFinalization = (typeof FinalizationRegistry === 'undefined')
        ? { register: () => {}, unregister: () => {} }
        : new FinalizationRegistry(ptr => wasm.__wbg_traceout_free(ptr, 1));
    const WelcomeOutFinalization = (typeof FinalizationRegistry === 'undefined')
        ? { register: () => {}, unregister: () => {} }
        : new FinalizationRegistry(ptr => wasm.__wbg_welcomeout_free(ptr, 1));

    function addToExternrefTable0(obj) {
        const idx = wasm.__externref_table_alloc();
        wasm.__wbindgen_externrefs.set(idx, obj);
        return idx;
    }

    function getArrayJsValueFromWasm0(ptr, len) {
        ptr = ptr >>> 0;
        const mem = getDataViewMemory0();
        const result = [];
        for (let i = ptr; i < ptr + 4 * len; i += 4) {
            result.push(wasm.__wbindgen_externrefs.get(mem.getUint32(i, true)));
        }
        wasm.__externref_drop_slice(ptr, len);
        return result;
    }

    function getArrayU16FromWasm0(ptr, len) {
        ptr = ptr >>> 0;
        return getUint16ArrayMemory0().subarray(ptr / 2, ptr / 2 + len);
    }

    function getArrayU32FromWasm0(ptr, len) {
        ptr = ptr >>> 0;
        return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
    }

    function getArrayU64FromWasm0(ptr, len) {
        ptr = ptr >>> 0;
        return getBigUint64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
    }

    function getArrayU8FromWasm0(ptr, len) {
        ptr = ptr >>> 0;
        return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
    }

    let cachedBigUint64ArrayMemory0 = null;
    function getBigUint64ArrayMemory0() {
        if (cachedBigUint64ArrayMemory0 === null || cachedBigUint64ArrayMemory0.byteLength === 0) {
            cachedBigUint64ArrayMemory0 = new BigUint64Array(wasm.memory.buffer);
        }
        return cachedBigUint64ArrayMemory0;
    }

    let cachedDataViewMemory0 = null;
    function getDataViewMemory0() {
        if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
            cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
        }
        return cachedDataViewMemory0;
    }

    function getStringFromWasm0(ptr, len) {
        return decodeText(ptr >>> 0, len);
    }

    let cachedUint16ArrayMemory0 = null;
    function getUint16ArrayMemory0() {
        if (cachedUint16ArrayMemory0 === null || cachedUint16ArrayMemory0.byteLength === 0) {
            cachedUint16ArrayMemory0 = new Uint16Array(wasm.memory.buffer);
        }
        return cachedUint16ArrayMemory0;
    }

    let cachedUint32ArrayMemory0 = null;
    function getUint32ArrayMemory0() {
        if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
            cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
        }
        return cachedUint32ArrayMemory0;
    }

    let cachedUint8ArrayMemory0 = null;
    function getUint8ArrayMemory0() {
        if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
            cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
        }
        return cachedUint8ArrayMemory0;
    }

    function handleError(f, args) {
        try {
            return f.apply(this, args);
        } catch (e) {
            const idx = addToExternrefTable0(e);
            wasm.__wbindgen_exn_store(idx);
        }
    }

    function isLikeNone(x) {
        return x === undefined || x === null;
    }

    function passArray16ToWasm0(arg, malloc) {
        const ptr = malloc(arg.length * 2, 2) >>> 0;
        getUint16ArrayMemory0().set(arg, ptr / 2);
        WASM_VECTOR_LEN = arg.length;
        return ptr;
    }

    function passArray32ToWasm0(arg, malloc) {
        const ptr = malloc(arg.length * 4, 4) >>> 0;
        getUint32ArrayMemory0().set(arg, ptr / 4);
        WASM_VECTOR_LEN = arg.length;
        return ptr;
    }

    function passArray8ToWasm0(arg, malloc) {
        const ptr = malloc(arg.length * 1, 1) >>> 0;
        getUint8ArrayMemory0().set(arg, ptr / 1);
        WASM_VECTOR_LEN = arg.length;
        return ptr;
    }

    function passArrayJsValueToWasm0(array, malloc) {
        const ptr = malloc(array.length * 4, 4) >>> 0;
        for (let i = 0; i < array.length; i++) {
            const add = addToExternrefTable0(array[i]);
            getDataViewMemory0().setUint32(ptr + 4 * i, add, true);
        }
        WASM_VECTOR_LEN = array.length;
        return ptr;
    }

    function passStringToWasm0(arg, malloc, realloc) {
        if (realloc === undefined) {
            const buf = cachedTextEncoder.encode(arg);
            const ptr = malloc(buf.length, 1) >>> 0;
            getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
            WASM_VECTOR_LEN = buf.length;
            return ptr;
        }

        let len = arg.length;
        let ptr = malloc(len, 1) >>> 0;

        const mem = getUint8ArrayMemory0();

        let offset = 0;

        for (; offset < len; offset++) {
            const code = arg.charCodeAt(offset);
            if (code > 0x7F) break;
            mem[ptr + offset] = code;
        }
        if (offset !== len) {
            if (offset !== 0) {
                arg = arg.slice(offset);
            }
            ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
            const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
            const ret = cachedTextEncoder.encodeInto(arg, view);

            offset += ret.written;
            ptr = realloc(ptr, len, offset, 1) >>> 0;
        }

        WASM_VECTOR_LEN = offset;
        return ptr;
    }

    function takeFromExternrefTable0(idx) {
        const value = wasm.__wbindgen_externrefs.get(idx);
        wasm.__externref_table_dealloc(idx);
        return value;
    }

    let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
    cachedTextDecoder.decode();
    function decodeText(ptr, len) {
        return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
    }

    const cachedTextEncoder = new TextEncoder();

    if (!('encodeInto' in cachedTextEncoder)) {
        cachedTextEncoder.encodeInto = function (arg, view) {
            const buf = cachedTextEncoder.encode(arg);
            view.set(buf);
            return {
                read: arg.length,
                written: buf.length
            };
        };
    }

    let WASM_VECTOR_LEN = 0;

    let wasmModule, wasmInstance, wasm;
    function __wbg_finalize_init(instance, module) {
        wasmInstance = instance;
        wasm = instance.exports;
        wasmModule = module;
        cachedBigUint64ArrayMemory0 = null;
        cachedDataViewMemory0 = null;
        cachedUint16ArrayMemory0 = null;
        cachedUint32ArrayMemory0 = null;
        cachedUint8ArrayMemory0 = null;
        wasm.__wbindgen_start();
        return wasm;
    }

    async function __wbg_load(module, imports) {
        if (typeof Response === 'function' && module instanceof Response) {
            if (!module.ok) {
                throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
            }

            if (typeof WebAssembly.instantiateStreaming === 'function') {
                try {
                    return await WebAssembly.instantiateStreaming(module, imports);
                } catch (e) {
                    const validResponse = expectedResponseType(module.type);

                    if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                        console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                    } else { throw e; }
                }
            }

            const bytes = await module.arrayBuffer();
            return await WebAssembly.instantiate(bytes, imports);
        } else {
            const instance = await WebAssembly.instantiate(module, imports);

            if (instance instanceof WebAssembly.Instance) {
                return { instance, module };
            } else {
                return instance;
            }
        }

        function expectedResponseType(type) {
            switch (type) {
                case 'basic': case 'cors': case 'default': return true;
            }
            return false;
        }
    }

    function initSync(module) {
        if (wasm !== undefined) return wasm;


        if (module !== undefined) {
            if (Object.getPrototypeOf(module) === Object.prototype) {
                ({module} = module)
            } else {
                console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
            }
        }

        const imports = __wbg_get_imports();
        if (!(module instanceof WebAssembly.Module)) {
            module = new WebAssembly.Module(module);
        }
        const instance = new WebAssembly.Instance(module, imports);
        return __wbg_finalize_init(instance, module);
    }

    async function __wbg_init(module_or_path) {
        if (wasm !== undefined) return wasm;


        if (module_or_path !== undefined) {
            if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
                ({module_or_path} = module_or_path)
            } else {
                console.warn('using deprecated parameters for the initialization function; pass a single object instead')
            }
        }

        if (module_or_path === undefined && script_src !== undefined) {
            module_or_path = script_src.replace(/\.js$/, "_bg.wasm");
        }
        const imports = __wbg_get_imports();

        if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
            module_or_path = fetch(module_or_path);
        }

        const { instance, module } = await __wbg_load(await module_or_path, imports);

        return __wbg_finalize_init(instance, module);
    }

    return Object.assign(__wbg_init, { initSync }, exports);
})({ __proto__: null });
module.exports = wasm_bindgen;
