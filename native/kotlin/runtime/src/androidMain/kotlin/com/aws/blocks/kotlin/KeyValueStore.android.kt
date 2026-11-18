// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.kotlin

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.security.KeyStoreException
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.security.KeyStore
import java.security.UnrecoverableKeyException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlin.io.encoding.Base64

/** [applicationId] is ignored on Android: the sandbox is the per-application location. */
internal actual fun platformKeyValueStore(name: String, applicationId: String?): KeyValueStore =
    AndroidKeyValueStore(
        prefs = {
            ContextProvider.applicationContext.getSharedPreferences("$name.keystore", Context.MODE_PRIVATE)
        },
        keys = KeystoreKeySource("com.aws.blocks.kotlin.$name"),
        legacy = EncryptedPreferencesLegacySource(name),
    )

/**
 * Where the store's encryption key lives. The Android Keystore cannot run on a plain JVM, so the
 * store reaches it only through this seam and host tests supply a key held in memory.
 */
internal interface KeySource {
    /**
     * Returns the key, or null when none is held or the one held can no longer be used. Throws when
     * the key store could not answer, or below API 33 could not say: neither must read as absent.
     */
    fun load(): SecretKey?

    fun create(): SecretKey

    fun delete()
}

/**
 * The file an earlier version of the library wrote with `EncryptedSharedPreferences`. Read to
 * move its entries over, then deleted; never receives entries again.
 */
internal interface LegacySource {
    fun exists(): Boolean

    /**
     * Returns every entry decrypted. Throws [LegacyKeyLostException] when the file no longer opens
     * under the `MasterKey` this device holds, so nothing in it will ever be readable again; a key
     * store that could not answer is a read failure that may clear on a later attempt.
     */
    fun readAll(): Map<String, String>

    /**
     * Identifies the file as it stands now, so one already taken over is told apart from one a
     * downgraded build has written since. Recorded alongside the entries it names.
     */
    fun stamp(): String

    fun delete()
}

internal class LegacyKeyLostException(cause: Throwable? = null) : Exception(cause)

/**
 * Stores each entry AES-GCM encrypted in plain [SharedPreferences], under a key the Android
 * Keystore holds and never exports.
 *
 * The key is bound to this device, as the `MasterKey` it replaces already was: a copy of the
 * application's data restored onto another device cannot decrypt the entries. A store whose key is
 * gone drops every entry, not only the one being read, since none of them can be read without it,
 * so the user signs in once; a value that will not decrypt under a present key is a read failure.
 *
 * Entry names are stored as they are given, where the `EncryptedSharedPreferences` this replaces
 * encrypted them too, so a name must not itself carry anything secret.
 *
 * The memoized key is resolved under this instance's lock and the migration under the `lazy`, so a
 * second caller cannot corrupt either. [clear] edits the file outside both, so an instance expects
 * the serialized calls its caller makes; two instances for one name would each hold a key.
 *
 * @param prefs the entry file, which must return the same instance for a name on every call:
 * [clear] reaches it directly, so a fresh instance each call would let a later migration write to a
 * file this one had not cleared. `Context.getSharedPreferences` holds one instance per file for the
 * life of the process, which is what the production caller relies on.
 */
internal class AndroidKeyValueStore(
    private val prefs: () -> SharedPreferences,
    private val keys: KeySource,
    private val legacy: LegacySource,
) : KeyValueStore {

    private companion object {
        const val GCM_NONCE_SIZE = 12
        const val GCM_TAG_BITS = 128

        // Not an entry: it records which earlier file this store has already taken over. The
        // underscores keep it clear of the names a caller gives, which are stored as given.
        const val TAKEN_OVER_KEY = "__migrated"
    }

    private var secretKey: SecretKey? = null

    /**
     * Resolved on first use so the migration runs inside the I/O dispatcher, and re-attempted on
     * the next access when it throws: `lazy` caches a value the block returned, not a failure.
     */
    private val store: SharedPreferences by lazy { prefs().also { migrateLegacyEntries(it) } }

    /**
     * Writes commit rather than apply: the call already suspends on [Dispatchers.IO], so there is
     * no caller thread to spare, and an applied write is still in flight when the call returns and
     * is lost if the process dies first.
     */
    override suspend fun put(key: String, value: String) {
        withContext(Dispatchers.IO) {
            val encrypted = encrypt(key, value, keyForWriting(store))
            if (!store.edit().putString(key, encrypted).commit()) {
                throw KeyValueStoreException("Could not write the entry for '$key'")
            }
        }
    }

    override suspend fun get(key: String): String? = withContext(Dispatchers.IO) {
        val encoded = store.getString(key, null) ?: return@withContext null
        val secret = currentKey() ?: run {
            // Safe for the sole caller, which keeps its whole jar under one key.
            dropEntries(store)
            return@withContext null
        }
        try {
            decrypt(key, encoded, secret)
        } catch (failure: Exception) {
            // The entry is there, so a failed decrypt is a read failure and not an absent key.
            throw KeyValueStoreException("Could not decrypt the stored entry for '$key'", failure)
        }
    }

    /**
     * Deletes every entry but keeps the key, unlike [dropEntries]: the Keystore key is unchanged,
     * so the next [put] re-encrypts under it. A legacy file not yet migrated is deleted without
     * being imported, and recorded as dealt with first, so a delete that throws cannot undo this.
     */
    override suspend fun clear() {
        withContext(Dispatchers.IO) {
            // Reaches the file directly, not the lazy `store`: clearing needs no migration, and the
            // same handle means a later migration sees the cleared state.
            val editor = prefs().edit().clear()
            val present = legacy.exists()
            if (present) editor.putString(TAKEN_OVER_KEY, legacy.stamp())
            if (!editor.commit()) throw KeyValueStoreException("Could not clear the store")
            if (present) {
                deleteLegacy()
                forgetTakenOver(prefs())
            }
        }
    }

    /**
     * Copies the entries of the earlier file into this store, records the file it took them from in
     * the same write, then deletes it. A file written by a downgraded build has a stamp of its own,
     * so it is taken over in turn and overwrites the entries it names: it holds the later session.
     */
    private fun migrateLegacyEntries(target: SharedPreferences) {
        if (!legacy.exists()) return
        val stamp = legacy.stamp()
        if (target.getString(TAKEN_OVER_KEY, null) == stamp) {
            // This file's entries are already here and only its delete failed, which the access
            // that took it over reported. Copying it again would put them back over the live ones,
            // and failing again would fail every access, so the delete is all that is retried.
            if (runCatching { legacy.delete() }.isSuccess) forgetTakenOver(target)
            return
        }
        val entries = try {
            legacy.readAll()
        } catch (_: LegacyKeyLostException) {
            recordTakenOver(target, stamp)
            deleteLegacy()
            forgetTakenOver(target)
            return
        } catch (failure: Exception) {
            // Left in place for the next attempt, so the caller sees a read failure rather
            // than an empty store it would then overwrite.
            throw KeyValueStoreException("Could not read the entries stored by an earlier version", failure)
        }
        val secret = keyForWriting(target)
        val editor = target.edit()
        entries.forEach { (key, value) -> editor.putString(key, encrypt(key, value, secret)) }
        editor.putString(TAKEN_OVER_KEY, stamp)
        if (!editor.commit()) throw KeyValueStoreException("Could not write the migrated entries")
        deleteLegacy()
        forgetTakenOver(target)
    }

    /** Records a file whose entries are not coming over, so it is not read again. */
    private fun recordTakenOver(target: SharedPreferences, stamp: String) {
        if (!target.edit().putString(TAKEN_OVER_KEY, stamp).commit()) {
            throw KeyValueStoreException("Could not record the file left by an earlier version")
        }
    }

    /**
     * Drops the record once the file it names is gone, so a store holds only its own entries. A
     * write that does not reach disk needs no report: the file is absent, so nothing reads it.
     */
    private fun forgetTakenOver(target: SharedPreferences) {
        target.edit().remove(TAKEN_OVER_KEY).commit()
    }

    @Synchronized
    private fun currentKey(): SecretKey? = secretKey ?: loadKey()?.also { secretKey = it }

    @Synchronized
    private fun keyForWriting(target: SharedPreferences): SecretKey = currentKey() ?: run {
        // A new key cannot read anything the lost one wrote, so the whole store is cleared first.
        if (target.all.keys.any { it != TAKEN_OVER_KEY }) dropEntries(target)
        createKey().also { secretKey = it }
    }

    private fun loadKey(): SecretKey? = try {
        keys.load()
    } catch (failure: Exception) {
        throw KeyValueStoreException("Could not reach the key store", failure)
    }

    private fun createKey(): SecretKey = try {
        keys.create()
    } catch (failure: Exception) {
        throw KeyValueStoreException("Could not create the encryption key", failure)
    }

    @Synchronized
    private fun dropEntries(target: SharedPreferences) {
        // The record of an earlier file is not an entry: forgetting it here would read that file
        // back in on the next access, and a key this store cannot read is no reason to.
        val takenOver = target.getString(TAKEN_OVER_KEY, null)
        val editor = target.edit().clear()
        if (takenOver != null) editor.putString(TAKEN_OVER_KEY, takenOver)
        if (!editor.commit()) throw KeyValueStoreException("Could not clear the store")
        try {
            keys.delete()
        } catch (failure: Exception) {
            throw KeyValueStoreException("Could not remove the encryption key", failure)
        }
        secretKey = null
    }

    private fun deleteLegacy() = try {
        legacy.delete()
    } catch (failure: Exception) {
        throw KeyValueStoreException("Could not remove the file left by an earlier version", failure)
    }

    /**
     * Lets the cipher choose the nonce, which a Keystore key insists on, and stores it in front of
     * the ciphertext. The entry's [key] is bound in as associated data, so a value moved to another
     * key in the file no longer decrypts.
     */
    private fun encrypt(key: String, plaintext: String, secret: SecretKey): String = try {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secret)
        cipher.updateAAD(key.toByteArray())
        val ciphertext = cipher.doFinal(plaintext.toByteArray())
        check(cipher.iv.size == GCM_NONCE_SIZE) {
            "The cipher produced a ${cipher.iv.size}-byte nonce, not $GCM_NONCE_SIZE"
        }
        Base64.encode(cipher.iv + ciphertext)
    } catch (failure: Exception) {
        // Keeps the nonce-size diagnostic visible in the wrapper rather than only in its cause.
        throw KeyValueStoreException("Could not encrypt the entry for '$key': ${failure.message}", failure)
    }

    private fun decrypt(key: String, encoded: String, secret: SecretKey): String {
        val combined = Base64.decode(encoded)
        val nonce = combined.copyOfRange(0, GCM_NONCE_SIZE)
        val ciphertext = combined.copyOfRange(GCM_NONCE_SIZE, combined.size)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, secret, GCMParameterSpec(GCM_TAG_BITS, nonce))
        cipher.updateAAD(key.toByteArray())
        return String(cipher.doFinal(ciphertext))
    }
}

/** Holds a non-exportable AES-256 key in the Android Keystore under [alias]. */
private class KeystoreKeySource(private val alias: String) : KeySource {

    private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    /**
     * `getKey` returns null for a missing alias at every API level, and that is loss. An
     * `UnrecoverableKeyException` is rethrown as a read failure below 33, where its cause cannot be
     * classified, and at 33+ when the key store itself is at fault; otherwise it too is loss.
     */
    override fun load(): SecretKey? = try {
        keyStore().getKey(alias, null) as SecretKey?
    } catch (failure: UnrecoverableKeyException) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || failure.isKeystoreOwnFault()) throw failure
        null
    }

    override fun create(): SecretKey {
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    override fun delete() {
        keyStore().deleteEntry(alias)
    }
}

internal const val ANDROID_KEYSTORE = "AndroidKeyStore"

/** The on-disk location an `EncryptedSharedPreferences` file named [name] takes under [dataDir]. */
internal fun legacyPrefsPath(dataDir: String, name: String): File = File(dataDir, "shared_prefs/$name.xml")

/**
 * The platform's write-ahead copy of [prefsFile], which `SharedPreferencesImpl` renames back over
 * the file on its next load, so a delete that leaves it behind brings the entries back.
 */
internal fun legacyBackupPath(prefsFile: File): File = File(prefsFile.path + ".bak")

internal fun Throwable.causeChain(): Sequence<Throwable> = generateSequence(this) { it.cause }

/**
 * Whether the key store, rather than the key, is what failed. Only API 33 and later can say, so
 * below it this is false for every failure.
 */
internal fun Throwable.isKeystoreOwnFault(): Boolean =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
        causeChain().filterIsInstance<KeyStoreException>()
            .any { it.isTransientFailure || it.isSystemError }
