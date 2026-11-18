// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.builder.CodegenModelBuilder
import com.aws.blocks.kotlin.generator.KotlinCodeGenerator
import com.aws.blocks.kotlin.parser.OpenRpcParser
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain

/** The `Api` file generated for one method `api.get` whose result has [resultSchema]. */
private fun api(resultSchema: String): String {
    val spec = """
    {
      "openrpc": "1.3.2",
      "info": { "title": "test", "version": "1.0.0" },
      "methods": [ { "name": "api.get", "params": [], "result": { "name": "R", "schema": $resultSchema } } ]
    }
    """.trimIndent()
    val model = CodegenModelBuilder().build(OpenRpcParser.parse(spec))
    return KotlinCodeGenerator("com.example.app").generate(model).files.single { it.name == "Api" }.toString()
}

private const val GUARD = "if (result is JsonNull) throw TransportException(\"Unexpected null result for api.get\")"

/**
 * A valid envelope can carry `"result": null`. For a result type that cannot hold null, decoding
 * it would throw kotlinx's own exception, so the generated method reports a TransportException
 * first, as the Swift client does. A result that can hold null decodes it as it did before.
 */
class NullResultGuardTest : FunSpec({

    test("a non-null result type reports a null result as a TransportException") {
        val source = api("""{ "type": "string" }""")
        source shouldContain GUARD
        source shouldContain "import com.aws.blocks.kotlin.exceptions.TransportException\n"
    }

    test("a list result type is guarded too") {
        api("""{ "type": "array", "items": { "type": "string" } }""") shouldContain GUARD
    }

    test("a nullable result type still accepts null") {
        val source = api("""{ "oneOf": [ { "type": "string" }, { "type": "null" } ] }""")
        source shouldNotContain "TransportException"
    }
})
