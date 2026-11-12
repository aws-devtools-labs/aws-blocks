package com.aws.blocks.kotlin

import java.nio.file.Path

/**
 * Keeps the key in `.key` beside the entries it protects — the arrangement every release before OS
 * custody used, and the one a store falls back to when no OS store can be used.
 *
 * **The key is unencrypted and protected only by file permissions.** On a POSIX filesystem the
 * store directory is `rwx------` and the key and entry files `rw-------`, which keeps other OS users
 * out. Elsewhere the store falls back to the owner-only [java.io.File] flags, which on Windows have
 * no effect on who can read a file: there the key and entries keep the access control list
 * inherited from the user profile, which by default keeps other standard users out but lets
 * administrators and the system account read them. In every case any process running as the same OS
 * user can read the key and decrypt the entries, and so can anything holding a backup or copy of
 * the directory. The encryption guards against casual inspection of the files, not against those
 * readers.
 *
 * That second reader is what an OS-held custody removes: a copy of the directory is useless without
 * the key, which is not in it. The first is not removable at this layer by any custody.
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
