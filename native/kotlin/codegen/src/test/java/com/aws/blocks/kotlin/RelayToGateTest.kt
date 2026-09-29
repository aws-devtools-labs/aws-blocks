package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.builder.CodegenModelBuilder
import com.aws.blocks.kotlin.generator.KotlinCodeGenerator
import com.aws.blocks.kotlin.generator.RelayToRequirement
import com.aws.blocks.kotlin.parser.OpenRpcParser
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain

/**
 * The spec is inline rather than a file because no shared fixture carries an `oidc/client`
 * transferable, and `native/codegen-fixtures/` is consumed by the Swift and Dart generators
 * too — adding a fixture there would churn their golden files.
 */
private val OIDC_SPEC = """
    {
      "openrpc": "1.3.2",
      "info": { "title": "test", "version": "1.0.0" },
      "methods": [
        {
          "name": "auth.getClient",
          "params": [],
          "result": {
            "name": "GetClientResult",
            "schema": { "x-blocks-transferable": "oidc/client" }
          }
        }
      ]
    }
""".trimIndent()

class RelayToGateTest : FunSpec({

    fun generate(
        relayTo: String?,
        requirement: RelayToRequirement,
    ): Pair<List<String>, String> {
        val generator = KotlinCodeGenerator(
            packageName = "test.generated",
            relayTo = relayTo,
            relayToRequirement = requirement,
        )
        val result = generator.generate(CodegenModelBuilder().build(OpenRpcParser.parse(OIDC_SPEC)))
        return result.warnings to result.files.joinToString("\n") { it.toString() }
    }

    test("required and missing produces a warning and a stub") {
        val (warnings, source) = generate(null, RelayToRequirement.Required)
        warnings.size shouldBe 1
        warnings.single() shouldContain "relayTo"
        source shouldContain "OIDC is not configured"
    }

    test("recommended and missing warns but emits the real client") {
        val (warnings, source) = generate(null, RelayToRequirement.Recommended)
        warnings.size shouldBe 1
        source shouldContain "OidcClient.fromJson"
    }

    test("not needed and missing is silent and emits the real client") {
        val (warnings, source) = generate(null, RelayToRequirement.NotNeeded)
        warnings.shouldBeEmpty()
        source shouldContain "OidcClient.fromJson"
    }

    test("a configured value is passed through and never warns") {
        val (warnings, source) = generate("myapp://auth", RelayToRequirement.Required)
        warnings.shouldBeEmpty()
        source shouldContain "\"myapp://auth\""
    }
})
