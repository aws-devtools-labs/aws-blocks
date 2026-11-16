package com.aws.blocks.kotlin

import io.kotest.assertions.throwables.shouldThrow
import io.kotest.matchers.shouldBe
import kotlin.test.Test

class KeyAliasTest {

    @Test
    fun namesTheStoreThenTheApplication() {
        keyAlias("cookies", "com.example.app") shouldBe "cookies:com.example.app"
    }

    @Test
    fun keepsTheApplicationIdAsSupplied() {
        // An OS secret store has no filename constraints, so nothing needs reducing the way a
        // directory name does. A legible entry is worth having when inspecting the store by hand.
        keyAlias("cookies", "My App/v2") shouldBe "cookies:My App/v2"
    }

    @Test
    fun distinctPairsNeverProduceOneAlias() {
        // The caller controls the application id and may put anything in it, colons included. With
        // the store name first, the first colon is always the real boundary, so no two distinct
        // pairs can collapse onto one alias.
        val aliases = listOf(
            keyAlias("cookies", "a"),
            keyAlias("cookies", "a:b"),
            keyAlias("cookies", ":a"),
            keyAlias("cookies", "a:"),
            keyAlias("tokens", "a"),
            keyAlias("tokens", "a:b"),
        )

        aliases.toSet().size shouldBe aliases.size
    }

    @Test
    fun refusesAStoreNameThatWouldMoveTheBoundary() {
        // Enforced where it is relied upon rather than assumed, because a future store name is the
        // one thing that could break the property above.
        shouldThrow<IllegalArgumentException> { keyAlias("oidc:state", "com.example.app") }
    }
}
