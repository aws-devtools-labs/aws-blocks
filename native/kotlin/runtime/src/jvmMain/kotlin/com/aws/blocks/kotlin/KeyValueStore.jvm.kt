package com.aws.blocks.kotlin

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.nio.file.AccessDeniedException
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Falls back to an in-memory store when no application id was configured. Writing to `~/.blocks`
 * itself would put every Blocks application the user runs in one directory — the defect this
 * fallback exists instead of.
 */
internal actual fun platformKeyValueStore(name: String, applicationId: String?): KeyValueStore {
    val directory = applicationStorageDirectoryOrNull(applicationId) ?: return InMemoryKeyValueStore()
    // The alias uses the directory's name — the already-normalized id — rather than the id as
    // supplied. Taking the raw id would leave `app`, ` app` and `.app` sharing one directory but
    // aliased apart, so under an OS secret store each would mint its own key for the same entries.
    return EncryptedFileKeyValueStore(name, directory, keyAlias(name, directory.name))
}

/**
 * Stores each entry as an AES-GCM encrypted file under `<[directory]>/<[name]>`, with the key held
 * by [KeyCustody] — the host OS where it can be, and a file beside the entries where it cannot.
 *
 * [directory] is already private to the application that supplied it, so the store names its
 * entries directly within it rather than inserting a directory of its own. It is resolved on first
 * use, off the calling thread, so creating it is not the caller's concern.
 *
 * [custodyFor] builds the custody for the resolved storage directory. It is a parameter so a test
 * can supply one directly instead of taking whatever this machine offers. What that custody does
 * and does not protect is documented on each implementation, because it differs between them: see
 * [FileKeyCustody] for the arrangement a store falls back to.
 *
 * An application that wants nothing written to disk at all should leave `applicationId` unset, so
 * the session is held in memory for the life of the process.
 */
internal class EncryptedFileKeyValueStore(
    private val name: String,
    private val directory: File,
    private val alias: String,
    private val custodyFor: (Path) -> KeyCustody = ::selectKeyCustody,
) : KeyValueStore {

    private companion object {
        const val GCM_NONCE_SIZE = 12
        const val GCM_TAG_BITS = 128

        /** Attempts to replace an entry a concurrent reader still has open. See [writeAtomically]. */
        const val MOVE_ATTEMPTS = 20
        const val MOVE_RETRY_MILLIS = 20L
    }

    private val storageDir: Path by lazy {
        val dir = File(directory, name).toPath()
        Files.createDirectories(dir)
        restrictToOwner(dir, directory = true)
        dir
    }

    private val custody: KeyCustody by lazy { custodyFor(storageDir) }

    /** Which custody this store ended up with. For tests: nothing acts on it at runtime. */
    internal val keyTier: KeyTier get() = custody.tier

    private val secretKey: SecretKey by lazy {
        val held = custody.load(alias)
        if (held != null) return@lazy SecretKeySpec(held, "AES")
        val fresh = ByteArray(AES_KEY_SIZE).also { SecureRandom().nextBytes(it) }
        SecretKeySpec(custody.storeIfAbsent(alias, fresh), "AES")
    }

    override suspend fun put(key: String, value: String) = withContext(Dispatchers.IO) {
        writeAtomically(pathFor(key), encrypt(value))
    }

    override suspend fun get(key: String): String? = withContext(Dispatchers.IO) {
        val path = pathFor(key)
        if (!Files.exists(path)) return@withContext null
        // The entry is there, so a failed decrypt is a read failure and not an absent key.
        decrypt(Files.readString(path))
            ?: throw KeyValueStoreException("Could not decrypt the stored entry for '$key'")
    }

    /**
     * Deletes every entry but keeps the key file. Dropping the key would leave this instance
     * writing with the key it already memoized while another process installed a different one,
     * so neither could read the other's entries.
     */
    override suspend fun clear() {
        withContext(Dispatchers.IO) {
            Files.newDirectoryStream(storageDir).use { entries ->
                entries.forEach {
                    if (it.fileName.toString() != KeyFile.KEY_FILE) Files.deleteIfExists(it)
                }
            }
        }
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
            moveIntoPlace(temp, target)
        } finally {
            Files.deleteIfExists(temp)
        }
    }

    /**
     * Renames [temp] over [target], retrying while another handle holds [target] open.
     *
     * Windows refuses to replace a file that is open elsewhere, where a POSIX filesystem allows it,
     * so a write that overlaps a read of the same entry is denied rather than queued. The refusal
     * lasts only as long as that read, so waiting is the whole remedy. Without it, the first write
     * to collide with a read fails, and because the jar swallows a failed write and retries on the
     * next call, the session would silently stop being saved under load.
     */
    private fun moveIntoPlace(temp: Path, target: Path) {
        repeat(MOVE_ATTEMPTS) { attempt ->
            try {
                try {
                    Files.move(temp, target, StandardCopyOption.ATOMIC_MOVE)
                } catch (_: AtomicMoveNotSupportedException) {
                    Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING)
                }
                return
            } catch (denied: AccessDeniedException) {
                // A genuine permissions problem raises the same exception, so give up eventually
                // and report it rather than waiting indefinitely on something that will not clear.
                if (attempt == MOVE_ATTEMPTS - 1) throw denied
                Thread.sleep(MOVE_RETRY_MILLIS)
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
