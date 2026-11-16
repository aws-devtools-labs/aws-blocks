package com.aws.blocks.kotlin

import java.nio.file.FileAlreadyExistsException
import java.nio.file.FileSystemException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.util.Base64

/**
 * The key bytes for one store, held in `.key` beside its entries.
 *
 * Holds no opinion on what the bytes mean: [FileKeyCustody] stores a raw AES key here and
 * [DpapiKeyCustody] stores a wrapped blob, which is longer. Validity is the caller's to judge,
 * which is why [read] takes a predicate.
 */
internal class KeyFile(private val directory: Path) {

    companion object {
        /**
         * The name a key is stored under, and the one entry a store's `clear` must leave alone.
         *
         * Not private, because that store has to name the same file to know which entry to keep.
         * Two independent spellings would mean a rename here silently deleted the key there.
         */
        internal const val KEY_FILE = ".key"

        /** Attempts to read a key another process has created but not yet finished writing. */
        private const val READ_ATTEMPTS = 5
        private const val READ_RETRY_MILLIS = 20L
    }

    private val path: Path get() = directory.resolve(KEY_FILE)

    /**
     * The stored bytes, or null when there are none or none that [isValid] accepts.
     *
     * Retries rather than returning bytes a concurrent writer has not finished producing, which
     * would make every entry written under the real key unreadable. A key installed by a link is
     * complete the moment it appears; the retry covers the fallback path on a filesystem without
     * links.
     */
    fun read(isValid: (ByteArray) -> Boolean): ByteArray? {
        repeat(READ_ATTEMPTS) { attempt ->
            if (!Files.exists(path)) return null
            val bytes = runCatching { Base64.getDecoder().decode(Files.readString(path)) }.getOrNull()
            if (bytes != null && isValid(bytes)) return bytes
            if (attempt < READ_ATTEMPTS - 1) Thread.sleep(READ_RETRY_MILLIS)
        }
        return null
    }

    /**
     * Publishes [bytes] unless a key is already there, reporting whether this call is the one that
     * installed it.
     *
     * The bytes are written to a temporary file and linked into place, because a link both fails
     * when the target exists and only ever exposes a file that is already complete. Creating the
     * key file first and writing to it afterwards leaves an empty key behind if the process stops
     * in between, and an empty key can never be read: entries become undecryptable and every write
     * fails until the file is deleted by hand.
     */
    fun installIfAbsent(bytes: ByteArray): Boolean {
        val encoded = Base64.getEncoder().encodeToString(bytes)
        val temp = Files.createTempFile(directory, KEY_FILE, ".tmp")
        try {
            // The link shares this file's inode, and with it these permissions.
            restrictToOwner(temp, directory = false)
            Files.writeString(temp, encoded)
            Files.createLink(path, temp)
            return true
        } catch (_: FileAlreadyExistsException) {
            // Another process installed a key first, and its key is the one that entries use. This
            // clause has to precede the one below, which catches its supertype.
            return false
        } catch (_: FileSystemException) {
            // A filesystem with no hard links (FAT, some network mounts) fails the link call itself
            // rather than declining to offer the operation.
            return createInPlace(encoded)
        } catch (_: UnsupportedOperationException) {
            // A provider that declines to offer links at all.
            return createInPlace(encoded)
        } finally {
            Files.deleteIfExists(temp)
        }
    }

    fun delete() {
        Files.deleteIfExists(path)
    }

    /**
     * Creates the key file directly, for filesystems that cannot link. This reopens the window a
     * link closes: the file exists before it holds anything, so a process that stops in between
     * leaves a key that cannot be read.
     */
    private fun createInPlace(encoded: String): Boolean = runCatching {
        Files.newOutputStream(path, StandardOpenOption.CREATE_NEW).use { out ->
            out.write(encoded.toByteArray())
        }
        restrictToOwner(path, directory = false)
    }.isSuccess
}
