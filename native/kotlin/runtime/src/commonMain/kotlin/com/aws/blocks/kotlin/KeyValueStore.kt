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

    /**
     * Drops every entry in this store, including any left by an earlier version of the library.
     * Keys are never enumerated, so an entry that cannot be read is still removed.
     */
    suspend fun clear()
}

internal expect fun encryptedKeyValueStore(name: String): KeyValueStore
