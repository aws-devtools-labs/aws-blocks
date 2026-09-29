package com.aws.blocks.kotlin

import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.atomicfu.locks.SynchronizedObject
import kotlinx.atomicfu.locks.synchronized
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

internal actual fun encryptedKeyValueStore(name: String): KeyValueStore =
    AndroidKeyValueStore(name)

private class AndroidKeyValueStore(
    private val name: String
) : KeyValueStore, SynchronizedObject() {

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

    override suspend fun put(key: String, value: String) = withContext(Dispatchers.IO) {
        synchronized(this@AndroidKeyValueStore) {
            prefs.edit().putString(key, value).apply()
        }
    }

    override suspend fun get(key: String): String? = withContext(Dispatchers.IO) {
        synchronized(this@AndroidKeyValueStore) {
            prefs.getString(key, null)
        }
    }

    override suspend fun remove(key: String) {
        withContext(Dispatchers.IO) {
            synchronized(this@AndroidKeyValueStore) {
                prefs.edit().remove(key).apply()
            }
        }
    }
}
