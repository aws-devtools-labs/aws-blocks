package com.aws.blocks.kotlin

/**
 * Persistent storage for small string values.
 *
 * Operations suspend because every implementation performs I/O — files, shared preferences or
 * the keychain — which must not run on the caller's thread.
 */
internal interface KeyValueStore {
    suspend fun put(key: String, value: String)
    suspend fun get(key: String): String?
    suspend fun remove(key: String)
}

internal expect fun encryptedKeyValueStore(name: String): KeyValueStore
