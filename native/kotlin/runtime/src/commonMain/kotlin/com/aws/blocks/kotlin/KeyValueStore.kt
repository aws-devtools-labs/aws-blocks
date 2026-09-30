package com.aws.blocks.kotlin

/**
 * Thrown when storage cannot be read or written, as opposed to a key simply being absent. The
 * difference matters to callers that would otherwise treat a temporary failure as empty storage
 * and overwrite what is still held there.
 */
internal class KeyValueStoreException(
    message: String,
    cause: Throwable? = null,
) : Exception(message, cause)

/**
 * Persistent storage for small string values.
 *
 * Operations suspend so that an implementation can move its I/O off the calling thread. The file
 * and shared-preferences backed stores do; the keychain-backed one runs its calls inline, because
 * they are short synchronous C calls rather than blocking I/O.
 */
internal interface KeyValueStore {
    suspend fun put(key: String, value: String)

    /**
     * Returns the stored value, or null when the key is absent. Throws when the key may well be
     * present but storage could not be read.
     */
    suspend fun get(key: String): String?

    /**
     * Drops every entry in this store, including any left by an earlier version of the library.
     * Keys are never enumerated, so an entry that cannot be read is still removed.
     */
    suspend fun clear()
}

internal expect fun encryptedKeyValueStore(name: String): KeyValueStore
