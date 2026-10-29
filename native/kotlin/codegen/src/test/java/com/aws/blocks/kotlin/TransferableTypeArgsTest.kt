package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.model.TransferableTypeArg
import com.aws.blocks.kotlin.model.narrowsTypeArg
import com.aws.blocks.kotlin.model.transferableTypeArg
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe

/**
 * Which way each tag's type arguments cross the wire, which decides whether an argument can be
 * narrowed to the values a spec permits. Narrowing one the runtime returns would drop whatever the
 * backend sent that the narrowed type can't represent.
 */
class TransferableTypeArgsTest : FunSpec({

    test("a realtime channel returns its message, so it is never narrowed") {
        transferableTypeArg("realtime/channel", 0) shouldBe TransferableTypeArg.Out
        narrowsTypeArg("realtime/channel", 0) shouldBe false
    }

    test("an OIDC client only takes its provider, so it is narrowed") {
        transferableTypeArg("oidc/client", 0) shouldBe TransferableTypeArg.In(name = "Provider")
        narrowsTypeArg("oidc/client", 0) shouldBe true
    }

    test("an undeclared tag's arguments are returned") {
        // A third-party binding's arguments are payloads, as are those of a tag with no entry.
        transferableTypeArg("example-iot/device-link", 0) shouldBe TransferableTypeArg.Out
        narrowsTypeArg("example-iot/device-link", 0) shouldBe false
    }

    test("a position a tag doesn't declare is returned") {
        // Reading past the declared arguments must not report a narrowing that isn't declared.
        narrowsTypeArg("oidc/client", 1) shouldBe false
        narrowsTypeArg("realtime/channel", 3) shouldBe false
    }
})
