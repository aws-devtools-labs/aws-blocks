// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.kotlin.oidc

import kotlin.io.encoding.Base64

object Pkce {

    fun generateCodeVerifier(): String = generateRandom()

    fun calculateCodeChallenge(verifier: String): String {
        val hash = sha256(verifier.encodeToByteArray())
        return Base64.UrlSafe.encode(hash).trimEnd('=')
    }

    fun generateRandom(): String {
        val bytes = secureRandomBytes(32)
        return Base64.UrlSafe.encode(bytes).trimEnd('=')
    }
}

internal expect fun sha256(input: ByteArray): ByteArray

internal expect fun secureRandomBytes(size: Int): ByteArray
