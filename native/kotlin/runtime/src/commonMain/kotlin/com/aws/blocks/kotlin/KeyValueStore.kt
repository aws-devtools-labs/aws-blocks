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
 * Operations suspend because every implementation moves its I/O off the calling thread. Keychain
 * calls count: they are inter-process requests that block until they return, not local calls.
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

/**
 * The store named [name] belongs in, for the target this runs on.
 *
 * Android and iOS ignore [platformConfig]: the OS gives each application a private location, so
 * the store derives its own. The JVM has neither a sandbox nor a per-application namespace, so it
 * uses the location [platformConfig] carries, and falls back to [InMemoryKeyValueStore] when the
 * application supplied none — guessing a directory under `$HOME` is what let two applications
 * read each other's entries.
 */
internal expect fun platformKeyValueStore(name: String, platformConfig: BlocksPlatformConfig): KeyValueStore

/**
 * Holds entries for the life of the process and writes nothing. What a target falls back to when
 * it has nowhere to persist: a session works until the process ends, rather than the application
 * failing to start or the library choosing a location on its behalf.
 */
internal class InMemoryKeyValueStore : KeyValueStore {
    private val entries = mutableMapOf<String, String>()

    override suspend fun put(key: String, value: String) {
        entries[key] = value
    }

    override suspend fun get(key: String): String? = entries[key]

    override suspend fun clear() {
        entries.clear()
    }
}
