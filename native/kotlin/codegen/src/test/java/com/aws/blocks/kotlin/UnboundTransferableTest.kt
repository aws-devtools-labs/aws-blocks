package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.builder.CodegenModelBuilder
import com.aws.blocks.kotlin.generator.GeneratorResult
import com.aws.blocks.kotlin.generator.KotlinCodeGenerator
import com.aws.blocks.kotlin.parser.OpenRpcParser
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain

private const val UNBOUND_TAG = "example-iot/device-link"

private val TELEMETRY_REF = """{ "${'$'}ref": "#/components/schemas/Telemetry" }"""

private val TELEMETRY_COMPONENTS = """,
      "components": {
        "schemas": {
          "Telemetry": {
            "type": "object",
            "properties": { "temperature": { "type": "number" } },
            "required": ["temperature"]
          }
        }
      }"""

private fun unboundResult(typeArgs: String): String =
    """{ "x-blocks-transferable": "$UNBOUND_TAG", "x-blocks-type-args": [ $typeArgs ] }"""

private fun nestedRecord(inner: String): String =
    """{ "type": "object", "properties": { "link": $inner }, "required": ["link"] }"""

private fun generate(spec: String, relayTo: String? = null): GeneratorResult {
    val model = CodegenModelBuilder().build(OpenRpcParser.parse(spec))
    return KotlinCodeGenerator("com.example.app", relayTo = relayTo).generate(model)
}

private fun GeneratorResult.source(): String = files.joinToString("\n") { it.toString() }

private fun resultSpec(resultSchema: String, components: String = ""): String =
    """
    {
      "openrpc": "1.3.2",
      "info": { "title": "test", "version": "1.0.0" },
      "methods": [
        {
          "name": "api.connectDevice",
          "params": [],
          "result": { "name": "ConnectDeviceResult", "schema": $resultSchema }
        }
      ]$components
    }
    """.trimIndent()

class UnboundTransferableTest : FunSpec({

    context("unbound transferable fallback") {
        val spec = resultSpec(unboundResult(TELEMETRY_REF), TELEMETRY_COMPONENTS)

        test("emits UnknownTransferable as the return type") {
            generate(spec).source() shouldContain "): UnknownTransferable"
        }

        test("emits UnknownTransferable.fromJson with the declared expectedTag") {
            generate(spec).source() shouldContain
                "UnknownTransferable.fromJson(result, expectedTag = \"$UNBOUND_TAG\")"
        }

        test("still emits the type-argument payload model") {
            generate(spec).source() shouldContain "class Telemetry"
        }

        test("emits the AWSBLOCKS-NATIVE-001 diagnostic naming the type arg") {
            generate(spec).warnings shouldBe listOf(
                "AWSBLOCKS-NATIVE-001: api.connectDevice returns unbound transferable " +
                    "'$UNBOUND_TAG' on kotlin; generated UnknownTransferable with type argument Telemetry.",
            )
        }

        test("diagnostic reports no models for a type-arg that produces none") {
            val primitiveArg = resultSpec(unboundResult("""{ "type": "string" }"""))
            generate(primitiveArg).warnings shouldBe listOf(
                "AWSBLOCKS-NATIVE-001: api.connectDevice returns unbound transferable " +
                    "'$UNBOUND_TAG' on kotlin; generated UnknownTransferable with no generated type-argument models.",
            )
        }

        test("diagnostic lists multiple type-arg models") {
            val plural = resultSpec(
                unboundResult(
                    """{ "${'$'}ref": "#/components/schemas/Foo" }, """ +
                        """{ "${'$'}ref": "#/components/schemas/Bar" }""",
                ),
                """,
      "components": {
        "schemas": {
          "Foo": { "type": "object", "properties": { "a": { "type": "string" } }, "required": ["a"] },
          "Bar": { "type": "object", "properties": { "b": { "type": "string" } }, "required": ["b"] }
        }
      }""",
            )
            generate(plural).warnings shouldBe listOf(
                "AWSBLOCKS-NATIVE-001: api.connectDevice returns unbound transferable " +
                    "'$UNBOUND_TAG' on kotlin; generated UnknownTransferable with type arguments Foo, Bar.",
            )
        }

        test("diagnostic names the element model for a list-wrapped type-arg") {
            val listArg = resultSpec(
                unboundResult("""{ "type": "array", "items": $TELEMETRY_REF }"""),
                TELEMETRY_COMPONENTS,
            )
            generate(listArg).warnings shouldBe listOf(
                "AWSBLOCKS-NATIVE-001: api.connectDevice returns unbound transferable " +
                    "'$UNBOUND_TAG' on kotlin; generated UnknownTransferable with type argument Telemetry.",
            )
        }

        test("diagnostic names the value model for a map-wrapped type-arg") {
            val mapArg = resultSpec(
                unboundResult("""{ "type": "object", "additionalProperties": $TELEMETRY_REF }"""),
                TELEMETRY_COMPONENTS,
            )
            generate(mapArg).warnings shouldBe listOf(
                "AWSBLOCKS-NATIVE-001: api.connectDevice returns unbound transferable " +
                    "'$UNBOUND_TAG' on kotlin; generated UnknownTransferable with type argument Telemetry.",
            )
        }

        test("diagnostic names the inner model for a nullable-wrapped type-arg") {
            val nullableArg = resultSpec(
                unboundResult("""{ "oneOf": [ $TELEMETRY_REF, { "type": "null" } ] }"""),
                TELEMETRY_COMPONENTS,
            )
            generate(nullableArg).warnings shouldBe listOf(
                "AWSBLOCKS-NATIVE-001: api.connectDevice returns unbound transferable " +
                    "'$UNBOUND_TAG' on kotlin; generated UnknownTransferable with type argument Telemetry.",
            )
        }

        test("a schema named UnknownTransferable coexists with the runtime fallback") {
            // Unlike Dart, Kotlin need not reserve the name: the explicit import binds the generated
            // fallback to the runtime type, so a same-named customer model can keep its own package.
            val src = generate(
                resultSpec(
                    unboundResult("""{ "${'$'}ref": "#/components/schemas/UnknownTransferable" }"""),
                    """,
      "components": {
        "schemas": {
          "UnknownTransferable": {
            "type": "object",
            "properties": { "x": { "type": "string" } },
            "required": ["x"]
          }
        }
      }""",
                ),
            ).source()
            src shouldContain "import com.aws.blocks.kotlin.UnknownTransferable"
            src shouldContain "UnknownTransferable.fromJson(result, expectedTag ="
            src shouldContain "class UnknownTransferable"
        }
    }

    context("direct-results-only (out-of-scope shapes keep prior behavior)") {
        test("nested record field stays JsonElement, no fallback, no diagnostic") {
            val result = generate(
                resultSpec(nestedRecord("""{ "x-blocks-transferable": "$UNBOUND_TAG" }""")),
            )
            result.source() shouldNotContain "UnknownTransferable"
            result.warnings shouldBe emptyList()
        }

        test("list of transferables stays out of scope, no fallback, no diagnostic") {
            val result = generate(
                resultSpec("""{ "type": "array", "items": { "x-blocks-transferable": "$UNBOUND_TAG" } }"""),
            )
            result.source() shouldNotContain "UnknownTransferable"
            result.warnings shouldBe emptyList()
        }

        test("nullable direct result is out of scope and left unchanged") {
            // Nullable is out of scope and kept at today's behavior; Kotlin's "today" for
            // an unbound tag is a generation failure, so this path is deliberately left to throw.
            shouldThrow<UnsupportedOperationException> {
                generate(
                    resultSpec("""{ "oneOf": [ { "x-blocks-transferable": "$UNBOUND_TAG" }, { "type": "null" } ] }"""),
                )
            }
        }
    }

    context("known tags map to their concrete type (drift guard)") {
        listOf(
            "realtime/channel" to "RealtimeChannel",
            "file-bucket/download" to "FileDownloadHandle",
            "file-bucket/upload" to "FileUploadHandle",
        ).forEach { (tag, expectedType) ->
            test("$tag maps to $expectedType with no diagnostic") {
                val result = generate(resultSpec("""{ "x-blocks-transferable": "$tag" }"""))
                result.source() shouldContain "): $expectedType"
                result.source() shouldNotContain "UnknownTransferable"
                result.warnings shouldBe emptyList()
            }
        }

        test("oidc/client maps to OidcClient with no diagnostic") {
            val result = generate(
                resultSpec("""{ "x-blocks-transferable": "oidc/client" }"""),
                relayTo = "com.example.app://auth/callback",
            )
            result.source() shouldContain "): OidcClient"
            result.source() shouldNotContain "UnknownTransferable"
            result.warnings shouldBe emptyList()
        }

        test("a tag outside the known set falls back only in the bare direct position") {
            val tag = "drift-probe/never-registered"
            generate(resultSpec("""{ "x-blocks-transferable": "$tag" }""")).source() shouldContain
                "): UnknownTransferable"
            generate(
                resultSpec(nestedRecord("""{ "x-blocks-transferable": "$tag" }""")),
            ).source() shouldNotContain "UnknownTransferable"
        }
    }
    context("tag escaping") {
        test("a tag with all five escaped characters emits a correct regular literal") {
            // quote, backslash, dollar, CR, LF - all five need escaping to compile and round-trip.
            val src = generate(resultSpec("""{ "x-blocks-transferable": "a\"b\\c${'$'}d\r\n" }""")).source()
            src shouldContain "expectedTag = \"a\\\"b\\\\c\\\$d\\r\\n\""
            src shouldNotContain "trimMargin"
        }
    }
})
