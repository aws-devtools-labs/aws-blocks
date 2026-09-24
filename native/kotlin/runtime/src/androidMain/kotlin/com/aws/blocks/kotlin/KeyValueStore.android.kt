package com.aws.blocks.kotlin

import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.atomicfu.locks.SynchronizedObject
import kotlinx.atomicfu.locks.synchronized

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

    override fun put(key: String, value: String) {
        synchronized(this) {
            prefs?.edit()?.putString(key, value)?.apply()
        }
    }

    override fun get(key: String): String? {
        return synchronized(this) {
            prefs.getString(key, null)
        }
    }

    override fun remove(key: String) {
        synchronized(this) {
            prefs.edit()?.remove(key)?.apply()
        }
    }
}
