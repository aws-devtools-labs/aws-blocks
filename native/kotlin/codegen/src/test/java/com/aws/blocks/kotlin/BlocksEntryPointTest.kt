package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.builder.CodegenModelBuilder
import com.aws.blocks.kotlin.generator.KotlinCodeGenerator
import com.aws.blocks.kotlin.parser.OpenRpcParser
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain

/**
 * The specs are inline because `native/codegen-fixtures/` is consumed by the Swift and Dart
 * generators too, and `x-blocks-endpoint` and multi-server specs appear in none of them.
 */
private fun spec(
    endpoint: String? = null,
    servers: String? = null,
): String {
    val endpointLine = endpoint?.let { """"x-blocks-endpoint": "$it",""" } ?: ""
    val serversLine = servers?.let { """"servers": $it,""" } ?: ""
    return """
        {
          "openrpc": "1.3.2",
          "info": { "title": "test", "version": "1.0.0" },
          $endpointLine
          $serversLine
          "methods": [
            {
              "name": "todos.list",
              "params": [],
              "result": { "name": "ListResult", "schema": { "type": "string" } }
            },
            {
              "name": "authCognito.currentUser",
              "params": [],
              "result": { "name": "CurrentUserResult", "schema": { "type": "string" } }
            }
          ]
        }
    """.trimIndent()
}

private fun generate(
    specJson: String,
    internalVisibility: Boolean = false,
): String {
    val generator = KotlinCodeGenerator(packageName = "test.generated", internalVisibility = internalVisibility)
    val model = CodegenModelBuilder().build(OpenRpcParser.parse(specJson))
    return generator.generate(model).files.joinToString("\n") { it.toString() }
}

class BlocksEntryPointTest : FunSpec({

    test("an api class takes the client the entry point owns rather than a server") {
        val source = generate(spec())

        source shouldContain "public class Todos(\n  private val client: BlocksClient,\n)"
        source shouldNotContain "BlocksClient(server)"
        source shouldNotContain "private val server: BlocksServer"
    }

    test("each namespace gets one extension property on the entry point") {
        val source = generate(spec())

        source shouldContain "public val Blocks.todos: Todos\n  get() = Todos(client)"
        source shouldContain "public val Blocks.authCognito: AuthCognito\n  get() = AuthCognito(client)"
    }

    test("an endpoint suffix is baked into the generated server constants") {
        val source = generate(
            spec(
                endpoint = "/aws-blocks/api",
                servers = """[{ "name": "sandbox", "url": "https://api.example.com/prod" }]""",
            ),
        )

        source shouldContain
            """BlocksServer(name = "sandbox", url = "https://api.example.com/prod/aws-blocks/api")"""
        // The runtime used to append the suffix; nothing may append it a second time.
        source shouldNotContain "/aws-blocks/api/aws-blocks/api"
        source shouldNotContain "server.url.toString()"
    }

    test("the endpoint suffix reaches the server the builder defaults to") {
        val source = generate(spec(endpoint = "/aws-blocks/api"))

        source shouldContain """BlocksServer(name = "local", url = "http://localhost:3001/aws-blocks/api")"""
    }

    test("without an endpoint the server url is the one the spec declares") {
        val source = generate(
            spec(servers = """[{ "name": "local", "url": "http://localhost:3001" }]"""),
        )

        source shouldContain """BlocksServer(name = "local", url = "http://localhost:3001")"""
    }

    test("internal visibility covers the extension property too") {
        val source = generate(spec(), internalVisibility = true)

        source shouldContain "internal val Blocks.todos: Todos"
        source.contains("public val Blocks.") shouldBe false
    }
})
