package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.builder.CodegenModelBuilder
import com.aws.blocks.kotlin.generator.KotlinCodeGenerator
import com.aws.blocks.kotlin.parser.OpenRpcParser
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import java.io.File

class CodegenFixturesTest : FunSpec({

    val regenerate = System.getProperty("REGENERATE_FIXTURES") == "1"
    val fixturesDir = System.getProperty("FIXTURES_DIR")?.let { File(it) }
        ?: throw IllegalStateException("Fixtures dir property must be set - check build.gradle.kts")

    if (fixturesDir.exists()) {
        fixturesDir.listFiles()
            ?.filter { it.isDirectory && File(it, "spec.json").exists() }
            ?.sortedBy { it.name }
            ?.forEach { fixture ->
                val specFile = File(fixture, "spec.json")
                val goldenDir = File(fixture, "kotlin")

                test("fixture: ${fixture.name}") {
                    val spec = specFile.readText()
                    val rpcModel = OpenRpcParser.parse(spec)
                    val codegenModel = CodegenModelBuilder().build(rpcModel)
                    val result = KotlinCodeGenerator("com.example.app").generate(codegenModel)

                    val generatedSource = result.files.joinToString("\n") { it.toString() }
                    Regex("@Serializable\\(with = (\\w+)::class\\)")
                        .findAll(generatedSource)
                        .forEach { match ->
                            generatedSource.contains("object ${match.groupValues[1]}") shouldBe true
                        }

                    if (regenerate) {
                        goldenDir.mkdirs()
                        goldenDir.listFiles()?.forEach { it.delete() }
                        for (generated in result.files) {
                            File(goldenDir, "${generated.name}.kt").writeText(generated.toString())
                        }
                        println("  ✓ regenerated ${fixture.name}: ${result.files.size} file(s)")
                    } else {
                        if (!goldenDir.exists() || goldenDir.listFiles()?.isEmpty() != false) {
                            error(
                                "No golden files for ${fixture.name}. " +
                                "Run: ./gradlew :codegen:regenerateFixtures"
                            )
                        }
                        for (generated in result.files) {
                            val goldenFile = File(goldenDir, "${generated.name}.kt")
                            if (!goldenFile.exists()) {
                                error(
                                    "Golden file missing: ${goldenFile.name}\n" +
                                    "Run: ./gradlew :codegen:regenerateFixtures"
                                )
                            }
                            generated.toString() shouldBe goldenFile.readText()
                        }
                    }
                }
            }
    } else {
        throw IllegalStateException("Missing fixtures directory")
    }
})
