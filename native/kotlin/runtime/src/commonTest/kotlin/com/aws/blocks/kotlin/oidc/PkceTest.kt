package com.aws.blocks.kotlin.oidc

import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.kotest.matchers.string.shouldMatch
import kotlin.test.Test

class PkceTest {

    @Test
    fun `generateCodeVerifier returns base64url string of correct length`() {
        val verifier = Pkce.generateCodeVerifier()
        // 32 bytes → 43 base64url chars (no padding)
        verifier.length shouldBe 43
        verifier shouldMatch Regex("^[A-Za-z0-9_-]+$")
    }

    @Test
    fun `generateCodeVerifier returns different values`() {
        val a = Pkce.generateCodeVerifier()
        val b = Pkce.generateCodeVerifier()
        a shouldNotBe b
    }

    @Test
    fun `calculateCodeChallenge produces correct S256 for known input`() {
        // RFC 7636 Appendix B test vector
        val verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        val challenge = Pkce.calculateCodeChallenge(verifier)
        challenge shouldBe "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    }

    @Test
    fun `generateRandom returns base64url string`() {
        val random = Pkce.generateRandom()
        random.length shouldBe 43
        random shouldMatch Regex("^[A-Za-z0-9_-]+$")
    }

    @Test
    fun `secureRandomBytes fills the full buffer and differs across calls`() {
        val samples = List(8) { secureRandomBytes(32) }
        samples.forEach { bytes ->
            bytes.size shouldBe 32
            bytes.all { it == 0.toByte() } shouldBe false
        }
        samples.map { it.toList() }.toSet().size shouldBe samples.size
    }

    @Test
    fun `generateRandom returns distinct values across calls`() {
        val values = List(8) { Pkce.generateRandom() }
        values.toSet().size shouldBe values.size
    }
}
