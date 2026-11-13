package com.aws.blocks.kotlin

import com.sun.jna.Library
import com.sun.jna.Native
import com.sun.jna.Pointer
import com.sun.jna.Structure
import com.sun.jna.ptr.PointerByReference
import java.nio.file.Path
import java.util.Base64

/**
 * Holds the key in the session keyring, so nothing of it is written beside the entries.
 *
 * The keyring is reachable by anything in the user's login session, so this buys no protection
 * against another program the user runs — nothing at this layer can. What it buys is at-rest
 * resistance: a copied disk, a backup or a synced folder yields entries whose key is not in the
 * copy. Where no keyring is running, which is the normal case on a server or in a container, the
 * self-test fails and the store falls back to a key beside the entries.
 *
 * [directory] is used only for the lock that serialises key creation; the key itself never goes
 * there.
 */
internal class SecretServiceKeyCustody(
    private val directory: Path,
    private val service: String,
) : KeyCustody {

    override val tier = KeyTier.OS

    /**
     * One {name, type} attribute slot. Unused — the alias goes in the schema name — but the slots
     * are part of the struct's size and must be declared.
     */
    class Attribute : Structure() {
        @JvmField var name: String? = null
        @JvmField var type: Int = 0
        override fun getFieldOrder(): List<String> = listOf("name", "type")
    }

    /**
     * `SecretSchema` as libsecret declares it, including the private tail.
     *
     * The reserved fields are not optional. JNA allocates exactly [Structure.size] bytes, so a
     * struct that stops after the attribute slots would let libsecret read past the end of what was
     * allocated. The full layout is 592 bytes.
     */
    class SecretSchema : Structure() {
        @JvmField var name: String? = null
        @JvmField var flags: Int = 0
        @JvmField var attributes: Array<Attribute> = Array(32) { Attribute() }
        @JvmField var reserved: Int = 0
        @JvmField var reserved1: Pointer? = null
        @JvmField var reserved2: Pointer? = null
        @JvmField var reserved3: Pointer? = null
        @JvmField var reserved4: Pointer? = null
        @JvmField var reserved5: Pointer? = null
        @JvmField var reserved6: Pointer? = null
        @JvmField var reserved7: Pointer? = null

        override fun getFieldOrder(): List<String> = listOf(
            "name", "flags", "attributes", "reserved",
            "reserved1", "reserved2", "reserved3", "reserved4",
            "reserved5", "reserved6", "reserved7",
        )
    }

    /**
     * The attribute list these calls end with is variadic.
     *
     * It must be declared `vararg` and called with no trailing arguments: JNA supplies the NULL
     * terminator itself. Declaring the exact arity instead and passing an explicit null happens to
     * work on Linux, because the arguments still land in the registers the ABI expects, and returns
     * garbage on platforms where variadic arguments go elsewhere.
     */
    private interface Libsecret : Library {
        fun secret_password_store_sync(
            schema: SecretSchema,
            collection: String?,
            label: String,
            password: String,
            cancellable: Pointer?,
            error: PointerByReference,
            vararg attributes: Any?,
        ): Boolean

        fun secret_password_lookup_sync(
            schema: SecretSchema,
            cancellable: Pointer?,
            error: PointerByReference,
            vararg attributes: Any?,
        ): Pointer?

        fun secret_password_clear_sync(
            schema: SecretSchema,
            cancellable: Pointer?,
            error: PointerByReference,
            vararg attributes: Any?,
        ): Boolean

        fun secret_password_free(password: Pointer)

        /**
         * GLib's, not libsecret's, and declared here on purpose.
         *
         * Loading `glib-2.0` separately would be a second soname to get right: the runtime package
         * ships `libglib-2.0.so.0` and the bare `.so` comes with the development package, which a
         * user's machine has no reason to have. Resolving the symbol against the libsecret handle
         * instead searches its dependencies, and libsecret links glib, so there is nothing further
         * to find or install.
         */
        fun g_error_free(error: Pointer)
    }

    /**
     * `GError` as GLib declares it: `{ GQuark domain; gint code; gchar *message; }`.
     *
     * Read-only here — libsecret allocates it and `g_error_free` releases it. `GQuark` and `gint`
     * are both 32-bit, so the layout is 4 + 4 + pointer on every platform this runs on.
     */
    class GError(pointer: Pointer?) : Structure(pointer) {
        @JvmField var domain: Int = 0
        @JvmField var code: Int = 0
        @JvmField var message: Pointer? = null
        override fun getFieldOrder(): List<String> = listOf("domain", "code", "message")
    }

    private companion object {
        val libsecret: Libsecret = Native.load("secret-1", Libsecret::class.java)

        /**
         * Reports what [call] set the error to, having released it, or null when it set none.
         *
         * Every one of these calls signals failure in two places: the return value, and an out
         * parameter that is left untouched on success. Reading only the return value makes a failed
         * call indistinguishable from an empty result — which for a lookup means "no key is held",
         * and that answer sends the caller on to store one over the key that is really there.
         */
        fun <T> reportingErrors(call: (PointerByReference) -> T): Pair<T, String?> {
            val slot = PointerByReference()
            val result = call(slot)
            val error = slot.value ?: return result to null
            return try {
                val detail = GError(error).also { it.read() }
                result to (detail.message?.getString(0) ?: "error code ${detail.code}")
            } finally {
                libsecret.g_error_free(error)
            }
        }
    }

    /**
     * The key is base64'd because the native API carries it as a NUL-terminated string. Roughly one
     * AES key in eight contains a zero byte, which would otherwise be truncated silently.
     *
     * A failed lookup throws rather than reporting no key. The call returns null for both, and
     * conflating them is destructive rather than merely wrong: [storeIfAbsent] takes "no key held"
     * as licence to store one, libsecret overwrites unconditionally, and the key every stored entry
     * was written under is then gone for good. A D-Bus failure shortly after login is enough to
     * reach it.
     */
    override fun load(alias: String): ByteArray? {
        val (held, failure) = reportingErrors { error ->
            libsecret.secret_password_lookup_sync(schemaFor(alias), null, error)
        }
        if (failure != null) {
            throw KeyValueStoreException("Could not read the encryption key from the session keyring: $failure")
        }
        if (held == null) return null
        val encoded = try {
            held.getString(0)
        } finally {
            libsecret.secret_password_free(held)
        }
        val bytes = runCatching { Base64.getDecoder().decode(encoded) }.getOrNull() ?: return null
        return bytes.takeIf { it.size == AES_KEY_SIZE }
    }

    /**
     * Serialised against every other process of this application, because libsecret overwrites
     * unconditionally and offers no store-only-if-absent. Without the lock, two processes each
     * minting a key can leave the second overwriting the first after the first has already written
     * entries under its own — and reading the key back afterwards would not detect it, because the
     * overwrite comes later.
     */
    override fun storeIfAbsent(alias: String, key: ByteArray): ByteArray =
        withDirectoryLock(directory) {
            // Throws rather than returning null if the keyring cannot be read, so a failed lookup
            // never reaches the unconditional overwrite below.
            load(alias)?.let { return@withDirectoryLock it }
            val (stored, failure) = reportingErrors { error ->
                libsecret.secret_password_store_sync(
                    schemaFor(alias),
                    // A collection alias the daemon does not recognise blocks in the native call
                    // indefinitely, and there is nothing to cancel it with. Null means the default.
                    null,
                    "$service session key",
                    Base64.getEncoder().encodeToString(key),
                    null,
                    error,
                )
            }
            if (!stored || failure != null) {
                throw KeyValueStoreException(
                    "The session keyring refused to store the encryption key" +
                        failure?.let { ": $it" }.orEmpty(),
                )
            }
            key
        }

    override fun delete(alias: String) {
        // The error is read and released rather than ignored, because leaving it allocated leaks
        // for the life of the process. A failure to delete is not worth throwing over: the only
        // caller is the self-test tidying up a probe it no longer needs.
        reportingErrors { error -> libsecret.secret_password_clear_sync(schemaFor(alias), null, error) }
    }

    /**
     * The alias is carried in the schema name rather than in an attribute. libsecret stores the
     * schema name as the item's `xdg:schema` attribute and matches on it, so lookups discriminate
     * between aliases with no attribute machinery at all. Items are never enumerated, so one schema
     * per alias costs nothing.
     */
    private fun schemaFor(alias: String): SecretSchema = SecretSchema().apply {
        name = "$service.$alias"
        flags = 0
    }
}
