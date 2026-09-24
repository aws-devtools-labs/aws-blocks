package com.aws.blocks.kotlin

import java.io.File
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.FileAlreadyExistsException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.PosixFilePermissions
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

internal actual fun encryptedKeyValueStore(name: String): KeyValueStore =
    EncryptedFileKeyValueStore(name)

/**
 * Stores each entry as an AES-GCM encrypted file under `<[root]>/.blocks/<[name]>`, with the key
 * in `.key` in the same directory.
 */
internal class EncryptedFileKeyValueStore(
    private val name: String,
    private val root: File = File(System.getProperty("user.home")),
) : KeyValueStore {

    private companion object {
        const val AES_KEY_SIZE = 32
        const val GCM_NONCE_SIZE = 12
        const val GCM_TAG_BITS = 128
        const val KEY_FILE = ".key"

        /** Attempts to read a key another process has created but not yet finished writing. */
        const val KEY_READ_ATTEMPTS = 5
        const val KEY_READ_RETRY_MILLIS = 20L
    }

    private val storageDir: Path by lazy {
        val dir = File(root, ".blocks/$name").toPath()
        Files.createDirectories(dir)
        restrictToOwner(dir, directory = true)
        dir
    }

    private val secretKey: SecretKey by lazy { loadOrCreateKey() }

    override fun put(key: String, value: String) {
        writeAtomically(pathFor(key), encrypt(value))
    }

    override fun get(key: String): String? {
        val path = pathFor(key)
        if (!Files.exists(path)) return null
        return decrypt(Files.readString(path))
    }

    override fun remove(key: String) {
        Files.deleteIfExists(pathFor(key))
    }

    private fun pathFor(key: String): Path =
        storageDir.resolve(Base64.getUrlEncoder().encodeToString(key.toByteArray()))

    /**
     * Writes through a temporary file and renames it over the target, so a reader sees either the
     * previous contents or the new ones and never a partial write.
     */
    private fun writeAtomically(target: Path, contents: String) {
        val temp = Files.createTempFile(storageDir, target.fileName.toString(), ".tmp")
        try {
            restrictToOwner(temp, directory = false)
            Files.writeString(temp, contents)
            try {
                Files.move(temp, target, StandardCopyOption.ATOMIC_MOVE)
            } catch (_: AtomicMoveNotSupportedException) {
                Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING)
            }
        } finally {
            Files.deleteIfExists(temp)
        }
    }

    /**
     * Creates the key only when one is absent. `CREATE_NEW` fails if the file already exists, so
     * concurrent first runs cannot each install a key and then write entries the other cannot
     * read: the loser reads the key the winner created.
     */
    private fun loadOrCreateKey(): SecretKey {
        val keyPath = storageDir.resolve(KEY_FILE)
        if (!Files.exists(keyPath)) {
            val bytes = ByteArray(AES_KEY_SIZE).also { SecureRandom().nextBytes(it) }
            try {
                Files.newOutputStream(keyPath, StandardOpenOption.CREATE_NEW).use { out ->
                    out.write(Base64.getEncoder().encodeToString(bytes).toByteArray())
                }
                restrictToOwner(keyPath, directory = false)
                return SecretKeySpec(bytes, "AES")
            } catch (_: FileAlreadyExistsException) {
                // Another process created the key between the check and the write.
            }
        }
        return readKey(keyPath)
    }

    /**
     * The creating process makes the key file visible before it has written to it, so a reader
     * arriving in that window sees a short file. Retry briefly rather than adopting a truncated
     * key, which would make every entry written with it unreadable.
     */
    private fun readKey(keyPath: Path): SecretKey {
        repeat(KEY_READ_ATTEMPTS) { attempt ->
            val bytes = runCatching { Base64.getDecoder().decode(Files.readString(keyPath)) }.getOrNull()
            if (bytes != null && bytes.size == AES_KEY_SIZE) return SecretKeySpec(bytes, "AES")
            if (attempt < KEY_READ_ATTEMPTS - 1) Thread.sleep(KEY_READ_RETRY_MILLIS)
        }
        throw IllegalStateException("Could not read the encryption key at $keyPath")
    }

    /**
     * Restricts access to the current user. POSIX permissions are unavailable on some
     * filesystems, where the coarser [File] flags are the only option.
     */
    private fun restrictToOwner(path: Path, directory: Boolean) {
        val permissions = if (directory) "rwx------" else "rw-------"
        runCatching { Files.setPosixFilePermissions(path, PosixFilePermissions.fromString(permissions)) }
            .onFailure {
                val file = path.toFile()
                file.setReadable(false, false)
                file.setReadable(true, true)
                file.setWritable(false, false)
                file.setWritable(true, true)
                if (directory) {
                    file.setExecutable(false, false)
                    file.setExecutable(true, true)
                }
            }
    }

    private fun encrypt(plaintext: String): String {
        val nonce = ByteArray(GCM_NONCE_SIZE).also { SecureRandom().nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey, GCMParameterSpec(GCM_TAG_BITS, nonce))
        val ciphertext = cipher.doFinal(plaintext.toByteArray())
        val combined = nonce + ciphertext
        return Base64.getEncoder().encodeToString(combined)
    }

    private fun decrypt(encoded: String): String? {
        return try {
            val combined = Base64.getDecoder().decode(encoded)
            val nonce = combined.copyOfRange(0, GCM_NONCE_SIZE)
            val ciphertext = combined.copyOfRange(GCM_NONCE_SIZE, combined.size)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, secretKey, GCMParameterSpec(GCM_TAG_BITS, nonce))
            String(cipher.doFinal(ciphertext))
        } catch (_: Exception) {
            null
        }
    }
}
