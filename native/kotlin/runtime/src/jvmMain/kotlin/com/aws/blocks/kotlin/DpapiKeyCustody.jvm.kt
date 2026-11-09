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

    private val file = KeyFile(directory)

    override fun load(alias: String): ByteArray? =
        file.read { unwrapOrNull(it, alias)?.size == AES_KEY_SIZE }
            ?.let { unwrapOrNull(it, alias) }

    override fun storeIfAbsent(alias: String, key: ByteArray): ByteArray {
        if (file.installIfAbsent(wrap(key, alias))) return key
        return load(alias)
            ?: throw KeyValueStoreException("Could not read the encryption key another process installed")
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
