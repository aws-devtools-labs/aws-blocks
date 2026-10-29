package com.aws.blocks.kotlin.oidc

import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.addressOf
import kotlinx.cinterop.allocArray
import kotlinx.cinterop.memScoped
import kotlinx.cinterop.readBytes
import kotlinx.cinterop.set
import kotlinx.cinterop.usePinned
import platform.CoreCrypto.CC_SHA256
import platform.CoreCrypto.CC_SHA256_DIGEST_LENGTH
import platform.Security.SecRandomCopyBytes
import platform.Security.errSecSuccess
import platform.Security.kSecRandomDefault
import platform.darwin.UInt8Var

@OptIn(ExperimentalForeignApi::class)
internal actual fun sha256(input: ByteArray): ByteArray = memScoped {
    val inputPtr = allocArray<UInt8Var>(input.size)
    for (i in input.indices) inputPtr[i] = input[i].toUByte()
    val outputPtr = allocArray<UInt8Var>(CC_SHA256_DIGEST_LENGTH)
    CC_SHA256(inputPtr, input.size.toUInt(), outputPtr)
    outputPtr.readBytes(CC_SHA256_DIGEST_LENGTH)
}

@OptIn(ExperimentalForeignApi::class)
internal actual fun secureRandomBytes(size: Int): ByteArray = memScoped {
    val ptr = allocArray<UInt8Var>(size)
    val status = SecRandomCopyBytes(kSecRandomDefault, size.toULong(), ptr)
    // Fail closed: never return the unfilled buffer when the system RNG call fails.
    check(status == errSecSuccess) { "SecRandomCopyBytes failed with OSStatus $status" }
    ptr.readBytes(size)
}
