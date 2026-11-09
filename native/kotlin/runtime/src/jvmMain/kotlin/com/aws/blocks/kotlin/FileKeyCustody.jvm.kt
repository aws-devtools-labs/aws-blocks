package com.aws.blocks.kotlin

import java.nio.file.Path

/**
 * Keeps the key in `.key` beside the entries it protects — the arrangement every release before OS
 * custody used, and the one a store falls back to when no OS store can be used.
 *
 * The alias is ignored: the file's location is already the namespace, because each application has
 * a directory of its own.
 */
internal class FileKeyCustody(directory: Path) : KeyCustody {

    override val tier = KeyTier.FILE

    private val file = KeyFile(directory)

    private val isWholeKey: (ByteArray) -> Boolean = { it.size == AES_KEY_SIZE }

    override fun load(alias: String): ByteArray? = file.read(isWholeKey)

    override fun storeIfAbsent(alias: String, key: ByteArray): ByteArray {
        if (file.installIfAbsent(key)) return key
        return file.read(isWholeKey)
            ?: throw KeyValueStoreException("Could not read the encryption key another process installed")
    }

    override fun delete(alias: String) = file.delete()
}
