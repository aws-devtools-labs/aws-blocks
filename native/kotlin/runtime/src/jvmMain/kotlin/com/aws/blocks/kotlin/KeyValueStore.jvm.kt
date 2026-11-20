// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.kotlin

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.nio.file.AccessDeniedException
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.NoSuchFileException
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Falls back to an in-memory store when no application id was configured. Writing to `~/.blocks`
 * itself would put every CDK Blocks application the user runs in one directory — the defect this
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

        /**
         * How many bytes of key fingerprint each entry carries. Eight is enough that two different
         * keys colliding is not worth reasoning about, and the cost is eleven base64 characters.
         */
        const val FINGERPRINT_SIZE = 8

        /** Where the ciphertext starts: the fingerprint and nonce precede it. */
        const val CIPHERTEXT_OFFSET = FINGERPRINT_SIZE + GCM_NONCE_SIZE

        /**
         * Mixed into the fingerprint so it cannot be mistaken for, or substituted with, a digest of
         * the same key taken for any other purpose.
         */
        val FINGERPRINT_DOMAIN = "aws-blocks:key-fingerprint:v1".toByteArray()

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

    /**
     * The one attempt this store makes to reach its key, successful or not.
     *
     * A failure is memoized as deliberately as a success, because asking the custody again cannot
     * help and is not free. A Keychain item this process is not allowed to read prompts the user on
     * every attempt, and the jar calls [get] and [put] for every request, so retrying would put a
     * dialog in front of the user indefinitely. `by lazy` alone does not do this: it caches the
     * value a successful block returned and re-runs the block after one that threw. Wrapping the
     * attempt in a [Result] makes the failure the cached value.
     *
     * [runCatching] takes [Throwable] rather than [Exception] for the same reason the self-test
     * does: an unloadable native library arrives as an [Error], on the first call rather than at
     * construction. Retrying that is equally hopeless.
     */
    private val keyAttempt: Result<SecretKey> by lazy { runCatching { resolveKey() } }

    private val secretKey: SecretKey get() = keyAttempt.getOrThrow()

    private fun resolveKey(): SecretKey {
        val held = custody.load(alias)
        if (held != null) return SecretKeySpec(held, "AES")
        val fresh = ByteArray(AES_KEY_SIZE).also { SecureRandom().nextBytes(it) }
        val installed = custody.storeIfAbsent(alias, fresh)
        // The fingerprint is computed here rather than read from [keyFingerprint], which resolves
        // the very key this function is still producing and would re-enter its own initializer.
        if (installed.contentEquals(fresh)) discardEntriesWrittenUnderAnOlderKey(fingerprintOf(installed))
        return SecretKeySpec(installed, "AES")
    }

    /**
     * A short digest of the key in hand, written into every entry this store encrypts so that a
     * reader can tell an entry written under some other key from one written under this one.
     *
     * This is the whole of how an orphan is recognised, and it has to be a property of the entry
     * rather than of the store, because the two directions are otherwise not symmetric. Asking
     * "did I mint the key?" identifies orphans only when the key is newer than the entries. The
     * mirror case — a key that is *older*, loaded from a store whose tier went away and came back
     * while a different key wrote the entries in between — looks identical to an intact directory
     * from the store's point of view, and the entries it cannot read are not corrupt but simply
     * someone else's. Comparing fingerprints answers both with one question.
     *
     * Publishing it alongside the ciphertext reveals nothing: it is a truncated digest of 256 bits
     * of entropy, so recovering the key from it is not a shortcut over guessing the key. What an
     * observer can tell is whether two entries share a key, which on the file tier is already
     * evident from the key sitting next to them.
     */
    private val keyFingerprint: ByteArray by lazy { fingerprintOf(secretKey.encoded) }

    private fun fingerprintOf(key: ByteArray): ByteArray =
        MessageDigest.getInstance("SHA-256")
            .digest(FINGERPRINT_DOMAIN + key)
            .copyOf(FINGERPRINT_SIZE)

    /**
     * Removes the entries that some earlier key wrote, after this store has minted a replacement.
     * Reached when a key is lost between launches — a Keychain item deleted, a keyring recreated
     * after a password change, a directory restored onto a machine the old key is not on.
     *
     * Tidying rather than correctness: [keyFingerprint] is what keeps an entry written under
     * another key from being mistaken for a corrupt one, and it does so without this sweep having
     * run. What the sweep adds is that a directory does not accumulate entries no key on the
     * machine can read, waiting for a write to the same name to displace them.
     *
     * Minting is not on its own a licence to delete, which is why a deletion is justified by the
     * fingerprint the file itself carries rather than by having minted. The key is published
     * before this runs, so a second instance created at the same moment adopts it and can write an
     * entry while the sweep is in progress — an entry belonging to the key in hand, which deleting
     * would discard a session the caller believes was saved. Anything that cannot be read as
     * another key's is left alone: a staging file a concurrent writer has not finished, a file
     * whose contents do not decode, one too short to carry a fingerprint.
     *
     * One window stays open: the check and the delete both go by path, so an entry renamed into
     * place between them is deleted along with the stale one it replaced. The jar writes a single
     * name, so after a lost key that is the same name twice, which is where this is reachable.
     * Closing it means holding [withDirectoryLock] across every key resolution, a plain load
     * included, and that lock does not time out.
     *
     * Best-effort: a failure here leaves unreadable entries in place, which the fingerprint check
     * already copes with, so it does not deserve to fail the call that provoked it.
     */
    private fun discardEntriesWrittenUnderAnOlderKey(fingerprint: ByteArray) {
        runCatching {
            forEachEntry { path ->
                runCatching {
                    val envelope = envelopeAt(path) ?: return@runCatching
                    if (wasWrittenUnderAnotherKey(envelope, fingerprint)) Files.deleteIfExists(path)
                }
            }
        }
    }

    /**
     * Visits the stored entries, and only those.
     *
     * An entry's name is the base64url of the key it holds, which never starts with a dot, so the
     * dot prefix is what separates them from this library's own files — a key file under one of
     * [KeyFile]'s names, and the lock that serialises key creation. Naming those files to keep
     * instead would mean every tier that adds one has to be remembered here; asking what an entry
     * looks like cannot be forgotten in the same way.
     */
    private inline fun forEachEntry(action: (Path) -> Unit) {
        Files.newDirectoryStream(storageDir).use { paths ->
            paths.forEach { if (!it.fileName.toString().startsWith(".")) action(it) }
        }
    }

    override suspend fun put(key: String, value: String) = withContext(Dispatchers.IO) {
        writeAtomically(pathFor(key), encrypt(value))
    }

    override suspend fun get(key: String): String? = withContext(Dispatchers.IO) {
        val path = pathFor(key)
        if (!Files.exists(path)) return@withContext null
        val stored = try {
            Files.readString(path)
        } catch (_: NoSuchFileException) {
            // The sweep in [resolveKey] could delete this file between the [Files.exists] check
            // and this read on a concurrent reader. Treat as absent.
            return@withContext null
        }
        val envelope = decodeEnvelope(stored)
            ?: throw KeyValueStoreException("Could not decrypt the stored entry for '$key'")
        // An entry some other key wrote is not this store's to read, and reporting it as absent is
        // what lets the caller replace it. Reporting a failure instead would be taken as temporary
        // — the jar declines to overwrite an entry it could not read — and the session would never
        // persist again. The reverse matters just as much: an entry that does carry this key's
        // fingerprint and still will not decrypt has been damaged, and a caller told it was absent
        // would overwrite a jar that is still there.
        if (wasWrittenUnderAnotherKey(envelope, keyFingerprint)) return@withContext null
        decrypt(envelope)
            ?: throw KeyValueStoreException("Could not decrypt the stored entry for '$key'")
    }

    /**
     * Whether [envelope] carries a fingerprint other than [fingerprint].
     *
     * An envelope too short to hold one is left for [decrypt] to reject: it cannot have come from
     * this store and cannot be attributed to any key, so it is damage rather than another key's
     * entry. An entry written before fingerprints existed is long enough to reach the comparison
     * and fail it, which is the answer that gets it replaced.
     */
    private fun wasWrittenUnderAnotherKey(envelope: ByteArray, fingerprint: ByteArray): Boolean {
        if (envelope.size < CIPHERTEXT_OFFSET) return false
        return !envelope.copyOf(FINGERPRINT_SIZE).contentEquals(fingerprint)
    }

    /** The envelope stored at [path], or null when there is nothing there that decodes as one. */
    private fun envelopeAt(path: Path): ByteArray? =
        runCatching { decodeEnvelope(Files.readString(path)) }.getOrNull()

    private fun decodeEnvelope(stored: String): ByteArray? =
        runCatching { Base64.getDecoder().decode(stored) }.getOrNull()

    /**
     * Deletes every entry and leaves this library's own files alone. Dropping the key would leave
     * this instance writing with the key it already memoized while another process installed a
     * different one, so neither could read the other's entries.
     *
     * Dropping the lock file would be worse than it looks: unlinking it does not block, so the
     * process holding the lock keeps it on an inode nothing can reach any more while the next
     * process creates a fresh file and locks that. Both would then believe they hold the directory,
     * which is the race the lock exists to prevent.
     */
    override suspend fun clear() {
        withContext(Dispatchers.IO) {
            forEachEntry { Files.deleteIfExists(it) }
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

    /** `base64(fingerprint ‖ nonce ‖ ciphertext)`, the fingerprint naming the key that wrote it. */
    private fun encrypt(plaintext: String): String {
        val nonce = ByteArray(GCM_NONCE_SIZE).also { SecureRandom().nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey, GCMParameterSpec(GCM_TAG_BITS, nonce))
        val ciphertext = cipher.doFinal(plaintext.toByteArray())
        return Base64.getEncoder().encodeToString(keyFingerprint + nonce + ciphertext)
    }

    private fun decrypt(envelope: ByteArray): String? {
        return try {
            val nonce = envelope.copyOfRange(FINGERPRINT_SIZE, CIPHERTEXT_OFFSET)
            val ciphertext = envelope.copyOfRange(CIPHERTEXT_OFFSET, envelope.size)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, secretKey, GCMParameterSpec(GCM_TAG_BITS, nonce))
            String(cipher.doFinal(ciphertext))
        } catch (_: Exception) {
            null
        }
    }
}
