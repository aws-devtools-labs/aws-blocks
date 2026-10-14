package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.builder.CodegenModelBuilder
import com.aws.blocks.kotlin.generator.GeneratorResult
import com.aws.blocks.kotlin.generator.KotlinCodeGenerator
import com.aws.blocks.kotlin.parser.OpenRpcParseException
import com.aws.blocks.kotlin.parser.OpenRpcParser
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain

private const val TAG = "example-iot/device-link"
private const val KOTLIN_PACKAGE = "com.example.blocks.iot"
private const val IDENTITY = "example-iot-native"

private val TELEMETRY_REF = """{ "${'$'}ref": "#/components/schemas/Telemetry" }"""

private val TELEMETRY_SCHEMA = """
      "Telemetry": {
        "type": "object",
        "properties": { "temperature": { "type": "number" } },
        "required": ["temperature"]
      }"""

private fun androidPlatform(kotlinPackage: String = KOTLIN_PACKAGE) = """
          "android": {
            "package": {
              "group": "com.example.blocks",
              "artifact": "iot-native",
              "kotlinPackage": "$kotlinPackage"
            }
          }"""

private fun dartPlatform() = """
          "dart": { "package": { "name": "example_iot_native", "library": "example_iot_native.dart" } }"""

private fun packagesCatalog(identity: String = IDENTITY, platforms: String = androidPlatform()) = """
  "x-blocks-native-packages": {
    "schemaVersion": 1,
    "packages": {
      "$identity": {
        "platforms": {$platforms
        }
      }
    }
  }"""

private fun binding(
    tag: String = TAG,
    export: String = "deviceLink",
    pkg: String = IDENTITY,
    abi: String = "blocks-transferable-v1",
    arity: String = "1",
    kind: String = "transferable",
    id: String = "example-device-link",
) = """
      {
        "id": "$id",
        "kind": "$kind",
        "tag": "$tag",
        "package": "$pkg",
        "export": "$export",
        "abi": "$abi",
        "genericArity": $arity
      }"""

private fun bindingsCatalog(vararg bindings: String) = """
  "x-blocks-native-bindings": {
    "schemaVersion": 1,
    "bindings": [${bindings.joinToString(",")}
    ]
  }"""

private fun spec(
    resultSchema: String,
    extensions: String = "",
    schemas: String = "",
): String {
    val components = if (schemas.isEmpty()) "" else """,
  "components": { "schemas": {$schemas
    }
  }"""
    val top = if (extensions.isEmpty()) "" else ",$extensions"
    return """
    {
      "openrpc": "1.3.2",
      "info": { "title": "test", "version": "1.0.0" },
      "methods": [
        {
          "name": "api.connectDevice",
          "params": [],
          "result": { "name": "ConnectDeviceResult", "schema": $resultSchema }
        }
      ]$components$top
    }
    """.trimIndent()
}

private fun transferableResult(tag: String = TAG, typeArgs: String? = TELEMETRY_REF): String =
    if (typeArgs == null) """{ "x-blocks-transferable": "$tag" }"""
    else """{ "x-blocks-transferable": "$tag", "x-blocks-type-args": [ $typeArgs ] }"""

private fun generate(
    spec: String,
    excluded: Set<String> = emptySet(),
    relayTo: String? = null,
): GeneratorResult {
    val model = CodegenModelBuilder().build(OpenRpcParser.parse(spec))
    return KotlinCodeGenerator("com.example.app", relayTo = relayTo, excludedPackages = excluded)
        .generate(model)
}

private fun GeneratorResult.source(): String = files.joinToString("\n") { it.toString() }

class DeclaredTransferableBindingTest : FunSpec({

    context("arity one") {
        val generic = spec(
            transferableResult(),
            "${packagesCatalog()},${bindingsCatalog(binding())}",
            TELEMETRY_SCHEMA,
        )

        test("returns the declared type specialized on the generated payload model") {
            generate(generic).source() shouldContain "): DeviceLink<Telemetry> {"
        }

        test("hydrates through the ABI factory with a validated descriptor and a decoder") {
            generate(generic).source() shouldContain
                "DeviceLink.fromBlocksDescriptor<Telemetry>(validateTransferableDescriptor(result, " +
                "expectedTag = \"$TAG\")) { BlocksJson.decodeFromJsonElement<Telemetry>(it) }"
        }

        test("emits no unbound diagnostic") {
            generate(generic).warnings shouldBe emptyList()
        }

    }

    context("arity zero") {
        val plain = spec(
            transferableResult(typeArgs = null),
            "${packagesCatalog()},${bindingsCatalog(binding(arity = "0"))}",
        )

        test("returns the declared type unparameterized") {
            generate(plain).source() shouldContain "): DeviceLink {"
        }

        test("passes the validated descriptor and no decoder") {
            generate(plain).source() shouldContain
                "return DeviceLink.fromBlocksDescriptor(validateTransferableDescriptor(result, " +
                "expectedTag = \"$TAG\"))"
        }
    }

    test("a tag needing escapes emits a regular literal in expectedTag") {
        val tag = """a\"b\\c${'$'}d"""
        val src = generate(
            spec(
                transferableResult(tag = tag, typeArgs = null),
                "${packagesCatalog()},${bindingsCatalog(binding(tag = tag, arity = "0"))}",
            ),
        ).source()
        src shouldContain """expectedTag = "a\"b\\c\${'$'}d""""
        src shouldNotContain "trimMargin"
    }

    context("fallback is platform-local and absence is not an error") {
        fun fellBack(result: GeneratorResult) {
            result.source() shouldContain "): UnknownTransferable {"
            result.warnings shouldBe listOf(
                "AWSBLOCKS-NATIVE-001: api.connectDevice returns unbound transferable " +
                    "'$TAG' on kotlin; generated UnknownTransferable with type argument Telemetry.",
            )
        }

        test("a package offered on dart but not android falls back") {
            fellBack(
                generate(
                    spec(
                        transferableResult(),
                        "${packagesCatalog(platforms = dartPlatform())},${bindingsCatalog(binding())}",
                        TELEMETRY_SCHEMA,
                    ),
                ),
            )
        }

        test("a catalog with no binding for the tag falls back") {
            fellBack(
                generate(
                    spec(
                        transferableResult(),
                        "${packagesCatalog()},${bindingsCatalog(binding(tag = "example-iot/other"))}",
                        TELEMETRY_SCHEMA,
                    ),
                ),
            )
        }

        test("an opted-out package falls back") {
            fellBack(
                generate(
                    spec(
                        transferableResult(),
                        "${packagesCatalog()},${bindingsCatalog(binding())}",
                        TELEMETRY_SCHEMA,
                    ),
                    excluded = setOf(IDENTITY),
                ),
            )
        }

        test("opting out a different identity leaves the binding typed") {
            generate(
                spec(
                    transferableResult(),
                    "${packagesCatalog()},${bindingsCatalog(binding())}",
                    TELEMETRY_SCHEMA,
                ),
                excluded = setOf("some-other-package"),
            ).source() shouldContain "): DeviceLink<Telemetry>"
        }

        test("an undefined-kind binding with no tag is skipped, not rejected") {
            fellBack(
                generate(
                    spec(
                        transferableResult(),
                        "${packagesCatalog()}," + """
  "x-blocks-native-bindings": { "schemaVersion": 1, "bindings": [
      { "id": "facade-1", "kind": "facade", "package": "$IDENTITY" } ] }""",
                        TELEMETRY_SCHEMA,
                    ),
                ),
            )
        }

        test("a binding of an undefined kind is skipped, not rejected") {
            fellBack(
                generate(
                    spec(
                        transferableResult(),
                        "${packagesCatalog()},${bindingsCatalog(binding(kind = "facade"))}",
                        TELEMETRY_SCHEMA,
                    ),
                ),
            )
        }

        // docs/native-clients/codegen-design.md § Unbound transferables: a nullable result on an
        // unbound path still fails generation, including the two paths this change adds.
        test("a nullable result on an excluded package still fails generation") {
            shouldThrow<UnsupportedOperationException> {
                generate(
                    spec(
                        """{ "oneOf": [ ${transferableResult(typeArgs = null)}, { "type": "null" } ] }""",
                        "${packagesCatalog()},${bindingsCatalog(binding(arity = "0"))}",
                    ),
                    excluded = setOf(IDENTITY),
                )
            }
        }

        test("neither catalog present keeps the Iteration 0 output") {
            fellBack(generate(spec(transferableResult(), schemas = TELEMETRY_SCHEMA)))
        }
    }

    test("fixture 27 reports two unbound transferables and one unreferenced package") {
        val fixtures = java.io.File(System.getProperty("FIXTURES_DIR")!!)
        val spec = java.io.File(fixtures, "27-declared-transferable-bindings/spec.json").readText()
        val warnings = generate(spec).warnings
        warnings.count { it.startsWith("AWSBLOCKS-NATIVE-001") } shouldBe 2
        warnings.count { it.startsWith("AWSBLOCKS-NATIVE-003") } shouldBe 1
        warnings.size shouldBe 3
    }

    context("built-in tags cannot be replaced (drift guard)") {
        listOf(
            "realtime/channel" to "RealtimeChannel<JsonElement>",
            "file-bucket/download" to "FileDownloadHandle",
            "file-bucket/upload" to "FileUploadHandle",
            "oidc/client" to "OidcClient",
        ).forEach { (tag, runtimeType) ->
            test("a binding on $tag does not displace $runtimeType") {
                val result = generate(
                    spec(
                        transferableResult(tag = tag, typeArgs = null),
                        "${packagesCatalog()},${bindingsCatalog(binding(tag = tag, arity = "0"))}",
                    ),
                    relayTo = "com.example.app://auth/callback",
                )
                result.source() shouldContain "): $runtimeType {"
                result.source() shouldNotContain "import $KOTLIN_PACKAGE."
                result.source() shouldNotContain "fromBlocksDescriptor"
            }
        }

        test("a binding on a built-in tag with a disagreeing arity stays inert") {
            val result = generate(
                spec(
                    transferableResult(tag = "realtime/channel"),
                    "${packagesCatalog()}," +
                        bindingsCatalog(binding(tag = "realtime/channel", arity = "0")),
                    TELEMETRY_SCHEMA,
                ),
            )
            result.source() shouldContain "): RealtimeChannel<Telemetry>"
            result.source() shouldNotContain "fromBlocksDescriptor"
            result.warnings shouldBe emptyList()
        }
    }

    context("nullable direct results") {
        test("a nullable bound result hydrates to its optional concrete type") {
            val src = generate(
                spec(
                    """{ "oneOf": [ ${transferableResult()}, { "type": "null" } ] }""",
                    "${packagesCatalog()},${bindingsCatalog(binding())}",
                    TELEMETRY_SCHEMA,
                ),
            ).source()
            src shouldContain "): DeviceLink<Telemetry>? {"
            src shouldContain "DeviceLink.fromBlocksDescriptor<Telemetry>("
        }

        test("a nullable bound result returns null for a JSON-null body") {
            val src = generate(
                spec(
                    """{ "oneOf": [ ${transferableResult()}, { "type": "null" } ] }""",
                    "${packagesCatalog()},${bindingsCatalog(binding())}",
                    TELEMETRY_SCHEMA,
                ),
            ).source()
            src shouldContain "return if (result is JsonNull) null else DeviceLink.fromBlocksDescriptor<Telemetry>("
            src shouldContain "import kotlinx.serialization.json.JsonNull"
        }

        listOf(
            "file-bucket/download" to "FileDownloadHandle.fromJson(result)",
            "file-bucket/upload" to "FileUploadHandle.fromJson(result)",
            "realtime/channel" to "RealtimeChannel.fromJson(result) { it }",
        ).forEach { (tag, hydrate) ->
            test("a nullable $tag result returns null for a JSON-null body") {
                generate(
                    spec("""{ "oneOf": [ ${transferableResult(tag = tag, typeArgs = null)}, { "type": "null" } ] }"""),
                ).source() shouldContain "return if (result is JsonNull) null else $hydrate"
            }
        }

        test("a non-nullable built-in result emits no null branch") {
            generate(
                spec(transferableResult(tag = "file-bucket/download", typeArgs = null)),
            ).source() shouldNotContain "is JsonNull"
        }

        test("a non-nullable bound result emits no null branch") {
            generate(
                spec(
                    transferableResult(typeArgs = null),
                    "${packagesCatalog()},${bindingsCatalog(binding(arity = "0"))}",
                ),
            ).source() shouldNotContain "is JsonNull"
        }

        test("a nullable arity-zero bound result hydrates to its optional concrete type") {
            generate(
                spec(
                    """{ "oneOf": [ ${transferableResult(typeArgs = null)}, { "type": "null" } ] }""",
                    "${packagesCatalog()},${bindingsCatalog(binding(arity = "0"))}",
                ),
            ).source() shouldContain "): DeviceLink? {"
        }
    }

    context("direct results only") {
        test("a bound tag in a record field is not hydrated") {
            val nested = spec(
                """{ "type": "object", "properties": { "link": ${transferableResult(typeArgs = null)} }, """ +
                    """"required": ["link"] }""",
                "${packagesCatalog()},${bindingsCatalog(binding(arity = "0"))}",
            )
            val result = generate(nested)
            result.source() shouldNotContain "fromBlocksDescriptor"
            result.source() shouldNotContain "import $KOTLIN_PACKAGE.DeviceLink"
        }
    }

    context("unreferenced packages") {
        test("a package with no android platform is still reported as unreferenced") {
            generate(
                spec(transferableResult(typeArgs = null), packagesCatalog(platforms = """
          "dart": { "package": { "name": "iot", "library": "iot.dart" } }""")),
            ).warnings.count { it.contains("AWSBLOCKS-NATIVE-003") } shouldBe 1
        }

        test("a declared package no binding names reports AWSBLOCKS-NATIVE-003") {
            generate(
                spec(
                    """{ "type": "string" }""",
                    packagesCatalog(),
                ),
            ).warnings shouldBe listOf(
                "AWSBLOCKS-NATIVE-003: native package '$IDENTITY' is declared but no binding " +
                    "references it; nothing is imported for it on kotlin.",
            )
        }

        test("a referenced package reports nothing") {
            generate(
                spec(
                    transferableResult(typeArgs = null),
                    "${packagesCatalog()},${bindingsCatalog(binding(arity = "0"))}",
                ),
            ).warnings shouldBe emptyList()
        }
    }

    context("malformed present metadata is a generation error") {
        fun rejected(extensions: String, resultSchema: String = transferableResult(typeArgs = null)): String =
            shouldThrow<OpenRpcParseException> { generate(spec(resultSchema, extensions)) }
                .message.shouldNotBeNull()

        test("an unsupported abi names the binding") {
            rejected(
                "${packagesCatalog()}," +
                    bindingsCatalog(binding(abi = "blocks-transferable-v2", arity = "0")),
            ) shouldContain "declares unsupported abi \"blocks-transferable-v2\""
        }

        test("a genericArity above the schema maximum is rejected") {
            rejected("${packagesCatalog()},${bindingsCatalog(binding(arity = "2"))}") shouldContain
                "\"genericArity\" between 0 and 1"
        }

        test("a binding naming an undeclared package is rejected") {
            rejected(
                "${packagesCatalog()}," + bindingsCatalog(binding(pkg = "not-declared", arity = "0")),
            ) shouldContain "names package \"not-declared\""
        }

        test("the same tag bound twice is rejected") {
            rejected(
                "${packagesCatalog()}," +
                    bindingsCatalog(binding(arity = "0"), binding(id = "second", arity = "0")),
            ) shouldContain "binds tag \"$TAG\" more than once"
        }

        test("an unknown schemaVersion is rejected") {
            rejected(
                """
  "x-blocks-native-packages": { "schemaVersion": 2, "packages": {} }""",
            ) shouldContain "requires \"schemaVersion\": 1, got 2"
        }

        test("an android field without a package object is rejected") {
            rejected(
                packagesCatalog(platforms = """
          "android": { "kotlinPackage": "$KOTLIN_PACKAGE" }"""),
            ) shouldContain "requires a \"package\" object"
        }

        test("an android package without kotlinPackage is rejected") {
            rejected(
                packagesCatalog(platforms = """
          "android": { "package": { "group": "g", "artifact": "a" } }"""),
            ) shouldContain "requires a non-blank string \"kotlinPackage\""
        }

        test("a blank kotlinPackage is rejected") {
            rejected(packagesCatalog(platforms = androidPlatform(kotlinPackage = "   "))) shouldContain
                "requires a non-blank string \"kotlinPackage\""
        }

        test("a non-object packages catalog is rejected") {
            rejected("""
  "x-blocks-native-packages": []""") shouldContain "x-blocks-native-packages must be an object"
        }

        test("a non-array bindings list is rejected") {
            rejected(
                "${packagesCatalog()}," + """
  "x-blocks-native-bindings": { "schemaVersion": 1, "bindings": {} }""",
            ) shouldContain "requires a \"bindings\" array"
        }

        test("an undefined-kind binding naming an undeclared package is rejected") {
            rejected(
                "${packagesCatalog()}," +
                    bindingsCatalog(binding(kind = "facade", pkg = "not-declared", arity = "0")),
            ) shouldContain "names package \"not-declared\""
        }

        test("the same tag bound by two kinds is rejected") {
            rejected(
                "${packagesCatalog()}," +
                    bindingsCatalog(binding(arity = "0"), binding(id = "second", kind = "facade", arity = "0")),
            ) shouldContain "binds tag \"$TAG\" more than once"
        }

        // One per rejecting clause, plus the keyword check the regex alone cannot catch.
        listOf("com..example", "com.example blocks", "9com.example", "fun")
            .forEach { bad ->
                test("a kotlinPackage of \"$bad\" is rejected") {
                    rejected(packagesCatalog(platforms = androidPlatform(kotlinPackage = bad))) shouldContain
                        "\"kotlinPackage\" is not a Kotlin package name: \"$bad\""
                }
            }

        test("a kotlinPackage with a Unicode letter is accepted") {
            generate(
                spec(
                    transferableResult(typeArgs = null),
                    "${packagesCatalog(platforms = androidPlatform(kotlinPackage = "com.café.blocks.iot"))}," +
                        bindingsCatalog(binding(arity = "0")),
                ),
            ).source() shouldContain "import com.café.blocks.iot.DeviceLink\n"
        }

        test("a package entry that is not an object is rejected") {
            rejected("""
  "x-blocks-native-packages": { "schemaVersion": 1, "packages": { "$IDENTITY": 7 } }""") shouldContain
                "must be an object"
        }

        test("an android package entry that is not an object is rejected") {
            rejected(packagesCatalog(platforms = """
          "android": { "package": 7 }""")) shouldContain "must be an object"
        }

        test("an android entry that is not an object is rejected") {
            rejected(packagesCatalog(platforms = """
          "android": 7""")) shouldContain "must be an object"
        }

        test("a non-string kotlinPackage is rejected") {
            rejected(
                packagesCatalog(platforms = """
          "android": { "package": { "group": "g", "artifact": "a", "kotlinPackage": 123 } }"""),
            ) shouldContain "requires a non-blank string \"kotlinPackage\""
        }

        // One per rejecting clause: leading non-letter, illegal character, dangling separator.
        listOf("9link", "iot.deviceLink", "link-").forEach { bad ->
            test("an export of \"$bad\" is rejected") {
                rejected(
                    "${packagesCatalog()}," + bindingsCatalog(binding(export = bad, arity = "0")),
                ) shouldContain "\"export\" is not an identifier: \"$bad\""
            }
        }

        test("an all-caps export keeps its case, so the import names what the package exports") {
            generate(
                spec(
                    transferableResult(typeArgs = null),
                    "${packagesCatalog()},${bindingsCatalog(binding(export = "URL", arity = "0"))}",
                ),
            ).source() shouldContain "import $KOTLIN_PACKAGE.URL\n"
        }

        test("only each segment's first character is raised") {
            generate(
                spec(
                    transferableResult(typeArgs = null),
                    "${packagesCatalog()},${bindingsCatalog(binding(export = "iot_API", arity = "0"))}",
                ),
            ).source() shouldContain "import $KOTLIN_PACKAGE.IotAPI\n"
        }

        test("a negative genericArity is rejected") {
            rejected("${packagesCatalog()},${bindingsCatalog(binding(arity = "-1"))}") shouldContain
                "requires an integer \"genericArity\" between 0 and 1"
        }

        test("a genericArity given as a JSON string is rejected") {
            rejected("${packagesCatalog()},${bindingsCatalog(binding(arity = "\"0\""))}") shouldContain
                "requires an integer \"genericArity\" between 0 and 1"
        }

        test("an unknown bindings schemaVersion is rejected") {
            rejected(
                "${packagesCatalog()}," + """
  "x-blocks-native-bindings": { "schemaVersion": 2, "bindings": [] }""",
            ) shouldContain "x-blocks-native-bindings requires \"schemaVersion\": 1, got 2"
        }

        test("a schemaVersion given as a JSON string is rejected") {
            rejected("""
  "x-blocks-native-packages": { "schemaVersion": "1", "packages": {} }""") shouldContain
                "requires \"schemaVersion\": 1, got \"1\""
        }

        test("a packages catalog without a packages object is rejected") {
            rejected("""
  "x-blocks-native-packages": { "schemaVersion": 1 }""") shouldContain
                "x-blocks-native-packages requires a \"packages\" object"
        }

        test("a package entry without platforms is rejected") {
            rejected("""
  "x-blocks-native-packages": {
    "schemaVersion": 1,
    "packages": { "$IDENTITY": {} }
  }""") shouldContain "requires a \"platforms\" object"
        }
    }

    context("arity must agree with the declared results") {
        fun mismatch(result: String, arity: String, schemas: String = "") =
            shouldThrow<OpenRpcParseException> {
                generate(spec(result, "${packagesCatalog()},${bindingsCatalog(binding(arity = arity))}", schemas))
            }.message.shouldNotBeNull()

        test("a nullable result with too few type args is rejected") {
            mismatch(
                """{ "oneOf": [ ${transferableResult(typeArgs = null)}, { "type": "null" } ] }""",
                "1",
            ) shouldContain "bound at genericArity 1, but its result carries 0"
        }

        test("a nullable result with too many type args is rejected") {
            mismatch(
                """{ "oneOf": [ ${transferableResult()}, { "type": "null" } ] }""",
                "0",
                TELEMETRY_SCHEMA,
            ) shouldContain "bound at genericArity 0, but its result carries 1"
        }

        test("too few type args on the result is rejected, naming the method") {
            shouldThrow<OpenRpcParseException> {
                generate(
                    spec(
                        transferableResult(typeArgs = null),
                        "${packagesCatalog()},${bindingsCatalog(binding(arity = "1"))}",
                    ),
                )
            }.message.shouldNotBeNull().shouldContain(
                "api.connectDevice returns \"$TAG\", bound at genericArity 1, " +
                    "but its result carries 0 x-blocks-type-args entries",
            )
        }

        test("too many type args on the result is rejected") {
            shouldThrow<OpenRpcParseException> {
                generate(
                    spec(
                        transferableResult(),
                        "${packagesCatalog()},${bindingsCatalog(binding(arity = "0"))}",
                        TELEMETRY_SCHEMA,
                    ),
                )
            }.message.shouldNotBeNull().shouldContain("bound at genericArity 0, but its result carries 1")
        }
    }
})
