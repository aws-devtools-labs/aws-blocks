package com.aws.blocks.kotlin

import com.sun.jna.platform.win32.Crypt32Util
import java.nio.file.Path

/**
 * Keeps the key in `.key` beside the entries, wrapped by the Windows Data Protection API so only
 * this user account on this machine can unwrap it.
 *
 * Windows has no store that holds a secret of this size by name and is worth the binding cost, so
 * the file stays and DPAPI protects what is in it. A copied disk, backup or synced folder therefore
 * yields a blob that unwraps nowhere else, which is the exfiltration case this exists for. It does
 * not stop another program the same user runs, which nothing at this layer can.
 *
 * The alias becomes DPAPI's optional entropy, so one application's blob is not readable as
 * another's even if both files are present.
 */
internal class DpapiKeyCustody(directory: Path) : KeyCustody {

    override val tier = KeyTier.OS

    private companion object {
        /**
         * Separate from [KeyFile.KEY_FILE] because what is in it is a wrapped blob, not a raw key.
         *
         * Sharing one name with the file tier made an upgrade from a release before OS custody
         * unrecoverable. That release left a raw key in `.key`; this tier cannot unwrap it, and
         * because the file was there the install declined, the read found nothing usable, and the
         * store threw. Nothing ever minted a key, so nothing ever cleaned up, and the user signed
         * in again on every launch for good. Under its own name the old file is simply not this
         * tier's, so the first launch mints a key and the session persists from then on.
         */
        const val DPAPI_KEY_FILE = ".key.dpapi"
    }

    private val file = KeyFile(directory, DPAPI_KEY_FILE)

    /** The file a release before OS custody left behind, which this tier can never read. */
    private val supersededRawKey = KeyFile(directory, KeyFile.KEY_FILE)

    override fun load(alias: String): ByteArray? =
        file.read { unwrapOrNull(it, alias)?.size == AES_KEY_SIZE }
            ?.let { unwrapOrNull(it, alias) }

    override fun storeIfAbsent(alias: String, key: ByteArray): ByteArray {
        if (install(key, alias)) return key
        load(alias)?.let { return it }
        // The file is there but holds nothing this tier can unwrap — a blob truncated by a stopped
        // process, or one wrapped for another user account or machine, as a restored backup leaves.
        // DPAPI is authenticated, so this is not a case of reading the wrong bytes: there are no
        // usable bytes. Nothing can have been written under a key nobody can unwrap, so replacing
        // it orphans nothing, and leaving it would stop every call for the life of the directory.
        file.delete()
        if (install(key, alias)) return key
        // Another process installed one between the delete and the install. Its key is the one to use.
        return load(alias)
            ?: throw KeyValueStoreException("Could not read the encryption key another process installed")
    }

    /**
     * Installs a wrapped [key], and on success drops the raw key an earlier release left behind.
     *
     * Removing it matters for a later launch that cannot reach DPAPI and falls back to the file
     * tier: it would otherwise find that raw key, read it successfully, and so never mint — leaving
     * it decrypting entries written under the DPAPI key, which fails for every one of them with no
     * path out. Once this call has installed a key, anything the raw file could decrypt is about to
     * be discarded as written under a superseded key, so the file has nothing left to offer.
     */
    private fun install(key: ByteArray, alias: String): Boolean {
        if (!file.installIfAbsent(wrap(key, alias))) return false
        supersededRawKey.delete()
        return true
    }

    override fun delete(alias: String) = file.delete()

    private fun wrap(key: ByteArray, alias: String): ByteArray =
        Crypt32Util.cryptProtectData(key, alias.toByteArray(), 0, null, null)

    /**
     * DPAPI is authenticated, so a blob that has been truncated, tampered with, or wrapped under a
     * different alias or user account fails here rather than unwrapping to the wrong bytes.
     */
    private fun unwrapOrNull(blob: ByteArray, alias: String): ByteArray? =
        runCatching { Crypt32Util.cryptUnprotectData(blob, alias.toByteArray(), 0, null) }.getOrNull()
}
