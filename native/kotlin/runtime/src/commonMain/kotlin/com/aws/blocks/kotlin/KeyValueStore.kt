package com.aws.blocks.kotlin

internal interface KeyValueStore {
    fun put(key: String, value: String)
    fun get(key: String): String?
    fun remove(key: String)
}

internal expect fun encryptedKeyValueStore(name: String): KeyValueStore
