package com.aws.blocks.kotlin

import kotlinx.cinterop.BetaInteropApi
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.alloc
import kotlinx.cinterop.memScoped
import kotlinx.cinterop.ptr
import kotlinx.cinterop.value
import kotlinx.coroutines.Dispatchers
// On Kotlin/Native the public `Dispatchers.IO` is an extension property shadowed by an internal
// member of the same name, so it resolves only when imported explicitly.
import kotlinx.coroutines.IO
import kotlinx.coroutines.withContext
import platform.CoreFoundation.CFDictionaryAddValue
import platform.CoreFoundation.CFDictionaryCreateMutable
import platform.CoreFoundation.CFDictionaryRef
import platform.CoreFoundation.CFRelease
import platform.CoreFoundation.CFTypeRef
import platform.CoreFoundation.CFTypeRefVar
import platform.CoreFoundation.kCFBooleanTrue
import platform.CoreFoundation.kCFTypeDictionaryKeyCallBacks
import platform.CoreFoundation.kCFTypeDictionaryValueCallBacks
import platform.Foundation.CFBridgingRelease
import platform.Foundation.CFBridgingRetain
import platform.Foundation.NSData
import platform.Foundation.NSString
import platform.Foundation.NSUTF8StringEncoding
import platform.Foundation.create
import platform.Foundation.dataUsingEncoding
import platform.Security.SecItemAdd
import platform.Security.SecItemCopyMatching
import platform.Security.SecItemDelete
import platform.Security.SecItemUpdate
import platform.Security.errSecItemNotFound
import platform.Security.errSecSuccess
import platform.Security.kSecAttrAccessible
import platform.Security.kSecAttrAccessibleAfterFirstUnlock
import platform.Security.kSecAttrAccount
import platform.Security.kSecAttrService
import platform.Security.kSecClass
import platform.Security.kSecClassGenericPassword
import platform.Security.kSecReturnData
import platform.Security.kSecValueData
import platform.darwin.OSStatus

internal actual fun encryptedKeyValueStore(name: String): KeyValueStore = KeychainKeyValueStore(name)

/**
 * Builds a Keychain query directly as a `CFDictionary`, runs [block] with it, then releases
 * the dictionary and any owned temporaries.
 *
 * A Kotlin `mapOf(...)` bridged to a dictionary via `CFBridgingRetain` does not produce a
 * valid query: `SecItem*` rejects it with `errSecParam`, and even when otherwise valid the
 * `CFBoolean` flags (e.g. `kSecReturnData`) do not survive the Foundation bridge. Creating
 * the `CFDictionary` directly from CoreFoundation values preserves every value type.
 *
 * Values come from [QueryBuilder]: `kSec*` constants pass through directly, while Kotlin
 * strings/data are bridged with `CFBridgingRetain` and tracked so their owning reference is
 * released after the query is used (the dictionary holds its own retain meanwhile).
 */
@OptIn(ExperimentalForeignApi::class)
private inline fun <R> withQuery(build: QueryBuilder.() -> Unit, block: (CFDictionaryRef) -> R): R {
    val builder = QueryBuilder().apply(build)
    val dict = CFDictionaryCreateMutable(
        null,
        builder.pairs.size.toLong(),
        kCFTypeDictionaryKeyCallBacks.ptr,
        kCFTypeDictionaryValueCallBacks.ptr
    )
    builder.pairs.forEach { (k, v) -> CFDictionaryAddValue(dict, k, v) }
    try {
        return block(dict!!)
    } finally {
        CFRelease(dict)
        // Release the references we created via CFBridgingRetain; the dictionary kept its own.
        builder.owned.forEach { CFRelease(it) }
    }
}

@OptIn(ExperimentalForeignApi::class, BetaInteropApi::class)
private class QueryBuilder {
    val pairs = mutableListOf<Pair<CFTypeRef?, CFTypeRef?>>()
    val owned = mutableListOf<CFTypeRef>()

    /** Adds a pair whose value is an immortal CF constant (not released). */
    fun constant(key: CFTypeRef?, value: CFTypeRef?) {
        pairs += key to value
    }

    /** Adds a pair whose value is bridged from a Kotlin object and owned by this builder. */
    fun bridged(key: CFTypeRef?, value: Any) {
        val ref = CFBridgingRetain(value)
        if (ref != null) owned += ref
        pairs += key to ref
    }
}

@OptIn(ExperimentalForeignApi::class, BetaInteropApi::class)
private class KeychainKeyValueStore(private val service: String) : KeyValueStore {

    /**
     * Updates the item in place, adding it only when it is not there yet. Deleting and re-adding
     * would leave nothing behind if the add failed, and the whole jar is one item, so that would
     * discard every cookie rather than one. A status that is neither success nor "not found" is
     * raised rather than dropped, so a caller does not read a failed write as a stored one.
     */
    override suspend fun put(key: String, value: String) = withContext(Dispatchers.IO) {
        val data = (value as NSString).dataUsingEncoding(NSUTF8StringEncoding)
            ?: throw KeyValueStoreException("The value for '$key' is not encodable as UTF-8")

        val updateStatus = withQuery({
            constant(kSecClass, kSecClassGenericPassword)
            bridged(kSecAttrService, service as NSString)
            bridged(kSecAttrAccount, key as NSString)
        }) { query ->
            withQuery({ bridged(kSecValueData, data) }) { attributes ->
                SecItemUpdate(query, attributes)
            }
        }
        if (updateStatus == errSecSuccess) return@withContext
        if (updateStatus != errSecItemNotFound) {
            throw KeyValueStoreException("Updating '$key' in the keychain failed: OSStatus $updateStatus")
        }

        val addStatus = withQuery({
            constant(kSecClass, kSecClassGenericPassword)
            bridged(kSecAttrService, service as NSString)
            bridged(kSecAttrAccount, key as NSString)
            bridged(kSecValueData, data)
            // Readable once the device has been unlocked after boot, rather than only while it is
            // unlocked, so a request that completes with the screen locked can still store what it
            // received. Set only when the item is created; an existing item keeps its own.
            constant(kSecAttrAccessible, kSecAttrAccessibleAfterFirstUnlock)
        }) { query ->
            SecItemAdd(query, null)
        }
        if (addStatus != errSecSuccess) {
            throw KeyValueStoreException("Adding '$key' to the keychain failed: OSStatus $addStatus")
        }
    }

    override suspend fun get(key: String): String? = withContext(Dispatchers.IO) {
        withQuery({
            constant(kSecClass, kSecClassGenericPassword)
            bridged(kSecAttrService, service as NSString)
            bridged(kSecAttrAccount, key as NSString)
            constant(kSecReturnData, kCFBooleanTrue)
        }) { query ->
            memScoped {
                val result = alloc<CFTypeRefVar>()
                val status: OSStatus = SecItemCopyMatching(query, result.ptr)
                // Only "not found" means the key is absent. Every other status — a locked device
                // denying access being the common one — leaves the item in place, so reporting it
                // as absent would invite the caller to overwrite an item it could not read.
                if (status == errSecItemNotFound) return@memScoped null
                if (status != errSecSuccess) {
                    throw KeyValueStoreException("Reading '$key' from the keychain failed: OSStatus $status")
                }
                val data = CFBridgingRelease(result.value) as? NSData
                    ?: throw KeyValueStoreException("The keychain returned no data for '$key'")
                NSString.create(data = data, encoding = NSUTF8StringEncoding) as? String
                    ?: throw KeyValueStoreException("The keychain value for '$key' is not valid UTF-8")
            }
        }
    }

    /**
     * Deletes every item for this service. Omitting `kSecAttrAccount` widens the query from one
     * entry to all of them, so entries this version never reads are still removed.
     */
    override suspend fun clear() {
        withContext(Dispatchers.IO) {
            withQuery({
                constant(kSecClass, kSecClassGenericPassword)
                bridged(kSecAttrService, service as NSString)
            }) { query ->
                SecItemDelete(query)
            }
        }
    }
}
