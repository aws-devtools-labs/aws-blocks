package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.builder.CodegenModelBuilder
import com.aws.blocks.kotlin.generator.KotlinCodeGenerator
import com.aws.blocks.kotlin.model.ResolvedType
import com.aws.blocks.kotlin.parser.OpenRpcParser
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldContainExactlyInAnyOrder
import io.kotest.matchers.ints.shouldBeGreaterThanOrEqual
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain

/**
 * Regression tests for shared `components/schemas` whose nested types share a name.
 *
 * Previously, a type nested inside a component was registered under just its field name
 * (e.g. `Value`), so if two components each nested a type named `value`, both resolved to a
 * single `Value` type in the generator's name-keyed index — fields decoded as the wrong type at
 * runtime with no generation-time warning. Types nested in a method's params/result were already
 * scoped per method and did not collide.
 *
 * The fix qualifies a component-nested type's registered identity by its parent (e.g. `FieldValue`
 * vs `SettingsValue`) while still emitting the bare class name nested under its parent, so two
 * components can each nest a same-named type.
 */
class SharedComponentNestedTypeScopingTest : FunSpec({

    // Two components each nesting a type named `value`: an object under `Field`, an enum under
    // `Settings` — the exact collision shape from the issue report.
    val spec = """
        {
          "openrpc": "1.3.2",
          "info": { "title": "test", "version": "1.0.0" },
          "methods": [
            {
              "name": "api.getField",
              "params": [
                { "name": "field", "required": true, "schema": { "${'$'}ref": "#/components/schemas/Field" } }
              ],
              "result": {
                "name": "GetFieldResult",
                "schema": { "${'$'}ref": "#/components/schemas/Settings" }
              }
            }
          ],
          "components": {
            "schemas": {
              "Field": {
                "type": "object",
                "properties": {
                  "attribute": { "type": "string" },
                  "value": {
                    "type": "object",
                    "properties": { "text": { "type": "string" } },
                    "required": ["text"]
                  }
                },
                "required": ["attribute", "value"]
              },
              "Settings": {
                "type": "object",
                "properties": {
                  "value": { "type": "string", "enum": ["monday", "tuesday"] }
                },
                "required": ["value"]
              }
            }
          }
        }
    """.trimIndent()

    test("same-named types nested in different components do not collide in the model") {
        val model = CodegenModelBuilder().build(OpenRpcParser.parse(spec))

        // The two nested `value` types must be registered as two distinct definitions, each scoped
        // to its parent component — not a single shared `Value`.
        val nestedValueDefs = model.typeDefinitions.filter { it.shortName == "Value" }
        nestedValueDefs.size shouldBe 2

        nestedValueDefs.map { it.parentSchema }.shouldContainExactlyInAnyOrder("Field", "Settings")

        // Identities (index keys) must be unique even though the emitted short name is shared.
        nestedValueDefs.map { it.name }.toSet().size shouldBe 2

        // The two definitions must keep their distinct SHAPES: Field.value is a record, Settings.value is an enum.
        val fieldValue = nestedValueDefs.first { it.parentSchema == "Field" }
        val settingsValue = nestedValueDefs.first { it.parentSchema == "Settings" }
        (fieldValue.type is ResolvedType.Record) shouldBe true
        (settingsValue.type is ResolvedType.Enum) shouldBe true
    }

    test("generated Kotlin emits both nested types, each scoped under its parent component") {
        val model = CodegenModelBuilder().build(OpenRpcParser.parse(spec))
        val result = KotlinCodeGenerator("com.example.app").generate(model)
        val source = result.files.joinToString("\n") { it.toString() }

        // Both parent components exist as data classes.
        source shouldContain "public data class Field("
        source shouldContain "public data class Settings("

        // Field nests a record `Value`; Settings nests an enum `Value`. Both are named `Value` but
        // live in different parents, so this is legal Kotlin (no duplicate top-level declaration).
        source shouldContain "public enum class Value"
        source shouldContain "public data class Value("

        // The enum keeps the weekday members (proving Settings.value is NOT the Field.value record).
        source shouldContain "monday"
        source shouldContain "tuesday"

        // There must be exactly one top-level (non-indented) `Value` of each kind at most — i.e. the
        // two `Value` declarations are nested (indented), never flattened to a single shared top-level type.
        val topLevelValueDecls = Regex("^public (data class|enum class) Value\\b", RegexOption.MULTILINE)
            .findAll(source).count()
        topLevelValueDecls shouldBe 0

        // Sanity: at least two `Value` declarations exist overall (the two nested ones).
        Regex("(data class|enum class) Value\\b").findAll(source).count() shouldBeGreaterThanOrEqual 2
    }
})
