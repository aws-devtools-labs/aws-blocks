package com.aws.blocks.kotlin

import com.sun.jna.Library
import com.sun.jna.Native
import com.sun.jna.NativeLibrary
import com.sun.jna.Pointer
import com.sun.jna.ptr.PointerByReference

/**
 * Holds the key in the login keychain, so nothing of it is written to disk by this process.
 *
 * macOS binds a keychain item to the code identity of the program that created it. A program with a
 * different identity is refused until the user consents, which is a boundary neither of the other
 * desktop platforms offers — though two applications built on the same Java runtime share one
 * identity, so it is a partial boundary rather than a strong one. The practical consequence is that
 * an application whose bundled runtime changes prompts its user once.
 */
internal class KeychainKeyCustody(private val service: String) : KeyCustody {

    override val tier = KeyTier.OS

    private interface Security : Library {
        fun SecItemAdd(attributes: Pointer, result: Pointer?): Int
        fun SecItemCopyMatching(query: Pointer, result: PointerByReference): Int
        fun SecItemDelete(query: Pointer): Int
    }

    private interface CoreFoundation : Library {
        fun CFStringCreateWithCString(allocator: Pointer?, cStr: String, encoding: Int): Pointer
        fun CFDataCreate(allocator: Pointer?, bytes: ByteArray, length: Long): Pointer
        fun CFDataGetLength(data: Pointer): Long
        fun CFDataGetBytePtr(data: Pointer): Pointer
        fun CFDictionaryCreate(
            allocator: Pointer?,
            keys: Array<Pointer>,
            values: Array<Pointer>,
            numValues: Long,
            keyCallBacks: Pointer,
            valueCallBacks: Pointer,
        ): Pointer

        fun CFRelease(cf: Pointer)
    }

    private companion object {
        const val UTF8 = 0x08000100
        const val ERR_SUCCESS = 0
        const val ERR_DUPLICATE_ITEM = -25299
        const val ERR_ITEM_NOT_FOUND = -25300

        val security: Security = Native.load("Security", Security::class.java)
        val coreFoundation: CoreFoundation = Native.load("CoreFoundation", CoreFoundation::class.java)

        /** A `kSec*` name is an exported global holding a CFTypeRef, so the pointer it holds is the value. */
        fun constant(library: String, name: String): Pointer =
            NativeLibrary.getInstance(library).getGlobalVariableAddress(name).getPointer(0)

        /** A callback table is a struct, so its address is the value, with no dereference. */
        fun structAddress(library: String, name: String): Pointer =
            NativeLibrary.getInstance(library).getGlobalVariableAddress(name)
    }

    /**
     * Null means no usable key is held: either no item at all, or an item whose contents are not a
     * key this store could have written. Anything else — above all a refused access prompt — is
     * thrown rather than reported as absent.
     *
     * The distinction is what keeps a denied prompt from being read as "mint a new key". Reported as
     * absent, it would send the caller into [storeIfAbsent], where the duplicate item already there
     * drives a second read and so a second prompt, on every call the jar makes for the life of the
     * process. Thrown, it reaches the caller once and stays there.
     */
    override fun load(alias: String): ByteArray? = withCf { cf ->
        val query = cf.dictionary(
            constant("Security", "kSecClass") to constant("Security", "kSecClassGenericPassword"),
            constant("Security", "kSecAttrService") to cf.string(service),
            constant("Security", "kSecAttrAccount") to cf.string(alias),
            constant("Security", "kSecReturnData") to constant("CoreFoundation", "kCFBooleanTrue"),
        )
        val out = PointerByReference()
        val status = security.SecItemCopyMatching(query, out)
        if (status == ERR_ITEM_NOT_FOUND) return@withCf null
        if (status != ERR_SUCCESS) {
            // errSecAuthFailed and errSecInteractionNotAllowed land here: an item this process is
            // not allowed to read, which is emphatically not the same as one that is not there.
            throw KeyValueStoreException("The keychain refused to return the encryption key (status $status)")
        }
        // `kSecReturnData` hands back a copy, so this reference is ours to release.
        val data = cf.owned(out.value) ?: return@withCf null
        val length = coreFoundation.CFDataGetLength(data).toInt()
        if (length != AES_KEY_SIZE) return@withCf null
        coreFoundation.CFDataGetBytePtr(data).getByteArray(0, length)
    }

    override fun storeIfAbsent(alias: String, key: ByteArray): ByteArray {
        val status = add(alias, key)
        if (status == ERR_SUCCESS) return key
        if (status != ERR_DUPLICATE_ITEM) {
            throw KeyValueStoreException("The keychain refused to store the encryption key (status $status)")
        }
        // An item is already there. Usually another process stored one first, and its key is the
        // one entries were written under, so it wins and this call adopts it.
        load(alias)?.let { return it }
        // The item is readable but holds nothing usable — not a refused prompt, which [load] throws
        // rather than reporting as absent. Nothing can have been written under it, so replacing it
        // orphans nothing, and leaving it would wedge the store: every call would find a duplicate
        // it cannot read and this method would throw for the life of the directory.
        delete(alias)
        if (add(alias, key) == ERR_SUCCESS) return key
        // Another process got there between the delete and the add. Its key is the one to use.
        return load(alias)
            ?: throw KeyValueStoreException("Could not read the encryption key another process stored")
    }

    private fun add(alias: String, key: ByteArray): Int = withCf { cf ->
        val attributes = cf.dictionary(
            constant("Security", "kSecClass") to constant("Security", "kSecClassGenericPassword"),
            constant("Security", "kSecAttrService") to cf.string(service),
            constant("Security", "kSecAttrAccount") to cf.string(alias),
            constant("Security", "kSecValueData") to cf.data(key),
        )
        security.SecItemAdd(attributes, null)
    }

    override fun delete(alias: String) {
        withCf { cf ->
            val query = cf.dictionary(
                constant("Security", "kSecClass") to constant("Security", "kSecClassGenericPassword"),
                constant("Security", "kSecAttrService") to cf.string(service),
                constant("Security", "kSecAttrAccount") to cf.string(alias),
            )
            security.SecItemDelete(query)
        }
    }

    /**
     * Runs [block] and releases every CoreFoundation object it created, in reverse order.
     *
     * A dictionary built with the CFType callback tables takes a retain of its own on everything put
     * into it, so releasing the dictionary does **not** release the strings and data created to fill
     * it — those references are still ours. Tracking them here is what keeps each one released
     * exactly once, on every path including the early returns.
     *
     * The `kSec*` globals are never released: they were never ours.
     */
    private fun <T> withCf(block: (CfScope) -> T): T {
        val scope = CfScope()
        return try {
            block(scope)
        } finally {
            scope.releaseAll()
        }
    }

    /** The CoreFoundation objects created for one call, and the only thing that releases them. */
    private class CfScope {
        private val created = mutableListOf<Pointer>()

        /** Takes ownership of a reference some other call returned to us, such as a copied value. */
        fun owned(pointer: Pointer?): Pointer? = pointer?.also { created += it }

        fun string(value: String): Pointer =
            coreFoundation.CFStringCreateWithCString(null, value, UTF8).also { created += it }

        fun data(bytes: ByteArray): Pointer =
            coreFoundation.CFDataCreate(null, bytes, bytes.size.toLong()).also { created += it }

        fun dictionary(vararg entries: Pair<Pointer, Pointer>): Pointer =
            coreFoundation.CFDictionaryCreate(
                null,
                entries.map { it.first }.toTypedArray(),
                entries.map { it.second }.toTypedArray(),
                entries.size.toLong(),
                structAddress("CoreFoundation", "kCFTypeDictionaryKeyCallBacks"),
                structAddress("CoreFoundation", "kCFTypeDictionaryValueCallBacks"),
            ).also { created += it }

        fun releaseAll() {
            created.asReversed().forEach { coreFoundation.CFRelease(it) }
            created.clear()
        }
    }
}
