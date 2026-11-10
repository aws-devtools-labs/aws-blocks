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

        val security: Security = Native.load("Security", Security::class.java)
        val coreFoundation: CoreFoundation = Native.load("CoreFoundation", CoreFoundation::class.java)

        /** A `kSec*` name is an exported global holding a CFTypeRef, so the pointer it holds is the value. */
        fun constant(library: String, name: String): Pointer =
            NativeLibrary.getInstance(library).getGlobalVariableAddress(name).getPointer(0)

        /** A callback table is a struct, so its address is the value, with no dereference. */
        fun structAddress(library: String, name: String): Pointer =
            NativeLibrary.getInstance(library).getGlobalVariableAddress(name)
    }

    override fun load(alias: String): ByteArray? {
        val query = dictionary(
            constant("Security", "kSecClass") to constant("Security", "kSecClassGenericPassword"),
            constant("Security", "kSecAttrService") to string(service),
            constant("Security", "kSecAttrAccount") to string(alias),
            constant("Security", "kSecReturnData") to constant("CoreFoundation", "kCFBooleanTrue"),
        )
        val out = PointerByReference()
        try {
            if (security.SecItemCopyMatching(query, out) != ERR_SUCCESS) return null
            val data = out.value ?: return null
            try {
                val length = coreFoundation.CFDataGetLength(data).toInt()
                if (length != AES_KEY_SIZE) return null
                return coreFoundation.CFDataGetBytePtr(data).getByteArray(0, length)
            } finally {
                coreFoundation.CFRelease(data)
            }
        } finally {
            coreFoundation.CFRelease(query)
        }
    }

    override fun storeIfAbsent(alias: String, key: ByteArray): ByteArray {
        val attributes = dictionary(
            constant("Security", "kSecClass") to constant("Security", "kSecClassGenericPassword"),
            constant("Security", "kSecAttrService") to string(service),
            constant("Security", "kSecAttrAccount") to string(alias),
            constant("Security", "kSecValueData") to data(key),
        )
        val status = try {
            security.SecItemAdd(attributes, null)
        } finally {
            coreFoundation.CFRelease(attributes)
        }
        if (status == ERR_SUCCESS) return key
        // Another process stored one first, and its key is the one entries were written under.
        if (status == ERR_DUPLICATE_ITEM) {
            return load(alias)
                ?: throw KeyValueStoreException("Could not read the encryption key another process stored")
        }
        throw KeyValueStoreException("The keychain refused to store the encryption key (status $status)")
    }

    override fun delete(alias: String) {
        val query = dictionary(
            constant("Security", "kSecClass") to constant("Security", "kSecClassGenericPassword"),
            constant("Security", "kSecAttrService") to string(service),
            constant("Security", "kSecAttrAccount") to string(alias),
        )
        try {
            security.SecItemDelete(query)
        } finally {
            coreFoundation.CFRelease(query)
        }
    }

    private fun string(value: String): Pointer =
        coreFoundation.CFStringCreateWithCString(null, value, UTF8)

    private fun data(bytes: ByteArray): Pointer =
        coreFoundation.CFDataCreate(null, bytes, bytes.size.toLong())

    /**
     * The dictionary owns its keys and values through the CFType callback tables, so releasing it
     * releases the strings and data built for it.
     */
    private fun dictionary(vararg entries: Pair<Pointer, Pointer>): Pointer =
        coreFoundation.CFDictionaryCreate(
            null,
            entries.map { it.first }.toTypedArray(),
            entries.map { it.second }.toTypedArray(),
            entries.size.toLong(),
            structAddress("CoreFoundation", "kCFTypeDictionaryKeyCallBacks"),
            structAddress("CoreFoundation", "kCFTypeDictionaryValueCallBacks"),
        )
}
