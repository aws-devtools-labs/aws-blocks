package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.builder.CodegenModelBuilder
import com.aws.blocks.kotlin.generator.KotlinCodeGenerator
import com.aws.blocks.kotlin.parser.OpenRpcParser
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import java.io.File

private fun generate(spec: String): String =
    KotlinCodeGenerator("com.example.app")
        .generate(CodegenModelBuilder().build(OpenRpcParser.parse(spec)))
        .files.joinToString("\n") { it.toString() }

private fun fixture(name: String): String =
    generate(File("../../codegen-fixtures/$name/spec.json").readText())

/** A method returning `{ value: <enum of values> }`. */
private fun resultEnumSpec(vararg values: String): String = """
    {
      "openrpc": "1.3.2",
      "info": { "title": "test", "version": "1.0.0" },
      "methods": [
        {
          "name": "api.get",
          "params": [],
          "result": { "name": "R", "schema": { "type": "object",
            "properties": { "mode": { "type": "string", "enum": [${values.joinToString(", ") { "\"$it\"" }}] } },
            "required": ["mode"] } }
        }
      ]
    }
""".trimIndent()

/**
 * A string enum a response carries is open: a sealed class whose known values are data objects,
 * plus `Unknown` for a value the client was generated without, with a string serializer. An enum
 * only parameters use stays a closed enum class.
 */
class OpenEnumTest : FunSpec({

    test("a result enum is a sealed class with an Unknown case and a string serializer") {
        val source = fixture("45-open-enums")
        source shouldContain "@Serializable(with = Status.Serializer::class)\npublic sealed class Status {"
        source shouldContain "public data object InProgress : Status() {\n    override val `value`: String = \"in-progress\""
        source shouldContain "public data class Unknown(\n    override val `value`: String,\n  ) : Status()"
        source shouldContain "public val entries: List<Status> by lazy { listOf(Todo, InProgress, Done) }"
        source shouldContain "PrimitiveSerialDescriptor(\"com.example.app.Status\", PrimitiveKind.STRING)"
        source shouldContain "override fun deserialize(decoder: Decoder): Status = fromValue(decoder.decodeString())"
    }

    test("enums in lists, maps, optionals, union arms and channel payloads are open") {
        val source = fixture("45-open-enums")
        for (name in listOf("Labels", "Priority", "Source", "Severity", "Change")) {
            source shouldContain "public sealed class $name {"
        }
    }

    test("an enum only parameters use stays a closed enum class") {
        fixture("45-open-enums") shouldContain "public enum class Sort {"
        val enums = fixture("05-enums")
        enums shouldContain "    @Serializable\n    public enum class Status {"
        enums shouldContain "      public sealed class Status {"
    }

    test("an oidc/client provider enum stays closed") {
        fixture("37-oidc-provider-enum") shouldNotContain "sealed class Provider"
    }

    test("a spec value named unknown keeps its constant, and the fallback steps aside") {
        val source = generate(resultEnumSpec("web", "unknown"))
        source shouldContain "public data object Unknown : Mode() {"
        source shouldContain "public data class UnknownValue(\n"
        source shouldContain "?: UnknownValue(value)"
    }

    test("a component only a parameter uses stays closed beside an inline result enum of its name") {
        val source = fixture("45-open-enums")
        source shouldContain "@Serializable\npublic enum class Mode {"
        source shouldContain "public sealed class Mode {"
    }

    test("a spec value named companion keeps its constant, and the companion object is named") {
        val source = generate(resultEnumSpec("companion", "other"))
        source shouldContain "public data object Companion : Mode() {"
        source shouldContain "public companion object Known {"
    }

    test("a spec value named serializer keeps its constant, and the serializer steps aside") {
        val source = generate(resultEnumSpec("serializer", "other"))
        source shouldContain "public data object Serializer : Mode() {"
        source shouldContain "@Serializable(with = Mode.Serializer2::class)"
        source shouldContain "public object Serializer2 : KSerializer<Mode> {"
    }

    test("a constant named like its enum takes a Value suffix") {
        val source = generate(resultEnumSpec("mode", "other"))
        source shouldContain "public data object ModeValue : Mode() {"
        source shouldNotContain "public data object Mode : Mode()"
    }

    test("constants that differ only in case are numbered, as are the fallback names") {
        val source = generate(resultEnumSpec("unknown", "un-known"))
        source shouldContain "public data object Unknown : Mode() {"
        source shouldContain "public data object UnKnown2 : Mode() {"
        source shouldContain "public data class UnknownValue(\n"
    }

    test("a result union with a string discriminator falls back to an Unknown arm") {
        val source = fixture("45-open-enums")
        // An arm is tagged `unknown`, so the fallback is `UnknownValue`.
        source shouldContain "public data class UnknownValue(\n        public val json: JsonObject,\n      ) : Result()"
        source shouldContain "else -> return UnknownValue(element)"
        source shouldContain "is UnknownValue -> value.json"
        source shouldContain "get() = (json[\"kind\"] as? JsonPrimitive)?.takeIf { it.isString }?.content"
    }

    test("a union only parameters use, or with a boolean discriminator, stays closed") {
        fixture("18-hybrid-arm") shouldNotContain "return Unknown(element)"
        // 24 has one union discriminated by the string `type` (open) and one by `isUpdated`.
        fixture("24-nullable-discriminated-union").split("else -> return Unknown(element)").size shouldBe 2
    }
})
