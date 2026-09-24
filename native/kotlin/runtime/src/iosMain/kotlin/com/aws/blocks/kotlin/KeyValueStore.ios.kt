package com.aws.blocks.kotlin

import kotlinx.cinterop.BetaInteropApi
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.alloc
import kotlinx.cinterop.memScoped
import kotlinx.cinterop.ptr
import kotlinx.cinterop.value
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
import platform.Security.errSecSuccess
import platform.Security.kSecAttrAccount
import platform.Security.kSecAttrService
import platform.Security.kSecClass
import platform.Security.kSecClassGenericPassword
import platform.Security.kSecMatchLimit
import platform.Security.kSecMatchLimitAll
import platform.Security.kSecReturnAttributes
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

    override fun put(key: String, value: String) {
        remove(key)
        val data = (value as NSString).dataUsingEncoding(NSUTF8StringEncoding) ?: return
        withQuery({
            constant(kSecClass, kSecClassGenericPassword)
            bridged(kSecAttrService, service as NSString)
            bridged(kSecAttrAccount, key as NSString)
            bridged(kSecValueData, data)
        }) { query ->
            SecItemAdd(query, null)
        }
    }

    override fun get(key: String): String? = withQuery({
        constant(kSecClass, kSecClassGenericPassword)
        bridged(kSecAttrService, service as NSString)
        bridged(kSecAttrAccount, key as NSString)
        constant(kSecReturnData, kCFBooleanTrue)
    }) { query ->
        memScoped {
            val result = alloc<CFTypeRefVar>()
            val status: OSStatus = SecItemCopyMatching(query, result.ptr)
            if (status != errSecSuccess) return@memScoped null
            val data = CFBridgingRelease(result.value) as? NSData ?: return@memScoped null
            NSString.create(data = data, encoding = NSUTF8StringEncoding) as? String
        }
    }

    override fun remove(key: String) {
        withQuery({
            constant(kSecClass, kSecClassGenericPassword)
            bridged(kSecAttrService, service as NSString)
            bridged(kSecAttrAccount, key as NSString)
        }) { query ->
            SecItemDelete(query)
        }
    }

    override fun getAll(): Map<String, String> = withQuery({
        constant(kSecClass, kSecClassGenericPassword)
        bridged(kSecAttrService, service as NSString)
        constant(kSecReturnAttributes, kCFBooleanTrue)
        constant(kSecReturnData, kCFBooleanTrue)
        constant(kSecMatchLimit, kSecMatchLimitAll)
    }) { query ->
        memScoped {
            val result = alloc<CFTypeRefVar>()
            val status: OSStatus = SecItemCopyMatching(query, result.ptr)
            if (status != errSecSuccess) return@memScoped emptyMap()

            @Suppress("UNCHECKED_CAST")
            val items = CFBridgingRelease(result.value) as? List<Map<Any?, Any?>>
                ?: return@memScoped emptyMap()
            items.mapNotNull { item ->
                val account = item[kSecAttrAccount.bridgedKey()] as? String ?: return@mapNotNull null
                val data = item[kSecValueData.bridgedKey()] as? NSData ?: return@mapNotNull null
                val value = NSString.create(data = data, encoding = NSUTF8StringEncoding) as? String
                    ?: return@mapNotNull null
                account to value
            }.toMap()
        }
    }
}

/**
 * The dictionary returned by `SecItemCopyMatching` is bridged to a Kotlin `Map` whose keys
 * are the `kSec*` attribute constants as bridged `NSString`s. `CFBridgingRelease` of a
 * retained copy yields that same `NSString` for lookup, without consuming the immortal
 * constant's own reference.
 */
@OptIn(ExperimentalForeignApi::class)
private fun CFTypeRef?.bridgedKey(): Any? =
    CFBridgingRelease(this?.let { platform.CoreFoundation.CFRetain(it) })
