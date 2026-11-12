// EncryptedSharedPreferences and MasterKey are deprecated upstream. They stay in use so that
// values already stored by this store keep their on-disk format and remain readable.
//
// MIGRATION NOTE: this suppression is temporary. Moving this store to an Android Keystore-backed
// AES-GCM key over plain SharedPreferences/DataStore, with a one-time read-old/write-new migration
// of existing entries, is tracked in https://github.com/aws-devtools-labs/aws-blocks/issues/1409.
// The migration reads existing entries with this library, so remove the suppression and the
// androidx.security:security-crypto dependency only after the migration has shipped in at least
// one release (see #1409, step 4).
@file:Suppress("DEPRECATION")

package com.aws.blocks.kotlin

import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** [applicationId] is ignored on Android: the sandbox is the per-application location. */
internal actual fun platformKeyValueStore(name: String, applicationId: String?): KeyValueStore =
    AndroidKeyValueStore(name)

private class AndroidKeyValueStore(
    private val name: String
) : KeyValueStore {

    private val prefs: SharedPreferences by lazy {
        val context = ContextProvider.applicationContext
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            name,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    /**
     * Writes commit rather than apply: the call already suspends on [Dispatchers.IO], so there is
     * no caller thread to spare, and an applied write is still in flight when the call returns and
     * is lost if the process dies first.
     */
    override suspend fun put(key: String, value: String) {
        withContext(Dispatchers.IO) { prefs.edit().putString(key, value).commit() }
    }

    override suspend fun get(key: String): String? = withContext(Dispatchers.IO) {
        prefs.getString(key, null)
    }

    override suspend fun clear() {
        withContext(Dispatchers.IO) { prefs.edit().clear().commit() }
    }
}
