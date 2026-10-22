package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.builder.CodegenModelBuilder
import com.aws.blocks.kotlin.generator.GeneratorResult
import com.aws.blocks.kotlin.generator.KotlinCodeGenerator
import com.aws.blocks.kotlin.parser.OpenRpcParser
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldContain
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
    namespaces: List<String> = listOf("todos", "authCognito"),
    withSharedType: Boolean = false,
): String {
    val endpointLine = endpoint?.let { """"x-blocks-endpoint": "$it",""" } ?: ""
    val serversLine = servers?.let { """"servers": $it,""" } ?: ""
    val componentsLine = if (withSharedType) {
        """"components": { "schemas": { "Shared": { "type": "object",""" +
            """ "properties": { "id": { "type": "string" } }, "required": ["id"] } } },"""
    } else {
        ""
    }
    val resultSchema = if (withSharedType) {
        """{ "${'$'}ref": "#/components/schemas/Shared" }"""
    } else {
        """{ "type": "string" }"""
    }
    val methods = namespaces.joinToString(",") { ns ->
        """{ "name": "$ns.list", "params": [],""" +
            """ "result": { "name": "ListResult", "schema": $resultSchema } }"""
    }
    return """
        {
          "openrpc": "1.3.2",
          "info": { "title": "test", "version": "1.0.0" },
          $endpointLine
          $serversLine
          $componentsLine
          "methods": [ $methods ]
        }
    """.trimIndent()
}

private fun result(
    specJson: String,
    internalVisibility: Boolean = false,
): GeneratorResult {
    val generator = KotlinCodeGenerator(packageName = "test.generated", internalVisibility = internalVisibility)
    return generator.generate(CodegenModelBuilder().build(OpenRpcParser.parse(specJson)))
}

private fun generate(
    specJson: String,
    internalVisibility: Boolean = false,
): String = result(specJson, internalVisibility).files.joinToString("\n") { it.toString() }

class BlocksEntryPointTest : FunSpec({

    test("an api class takes the client the entry point owns rather than a server") {
        val source = generate(spec())

        source shouldContain "public class Todos(\n  private val client: BlocksClient,\n)"
        source shouldNotContain "BlocksClient(server)"
        source shouldNotContain "private val server: BlocksServer"
    }

    test("each namespace gets one extension property on the entry point") {
        val source = generate(spec())

        source shouldContain "public val Blocks.todos: Todos\n  get() = Todos(client())"
        source shouldContain "public val Blocks.authCognito: AuthCognito\n  get() = AuthCognito(client())"
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

    test("the default server carries the rpc path when the spec declares no endpoint") {
        val source = generate(spec())

        source shouldContain """BlocksServer(name = "local", url = "http://localhost:3001/aws-blocks/api")"""
    }

    test("a declared server url is used as given") {
        val source = generate(
            spec(servers = """[{ "name": "staging", "url": "https://staging.example.com/rpc" }]"""),
        )

        source shouldContain """BlocksServer(name = "staging", url = "https://staging.example.com/rpc")"""
    }

    test("a zero-argument accessor is generated for the spec's default server") {
        val source = generate(spec(servers = """[{ "name": "local", "url": "http://localhost:3001" }]"""))

        source shouldContain
            "public operator fun Blocks.Companion.invoke(): Blocks = Blocks(Servers.local)"
    }

    test("the default server is the first the spec declares, whatever it is named") {
        val twoServers = """
            [
              { "name": "sandbox", "url": "https://api.example.com/prod" },
              { "name": "local", "url": "http://localhost:3001" }
            ]
        """.trimIndent()

        val source = generate(spec(endpoint = "/aws-blocks/api", servers = twoServers))

        source shouldContain
            "public operator fun Blocks.Companion.invoke(): Blocks = Blocks(Servers.sandbox)"
        // Every declared server keeps its own suffixed URL, not just the default.
        source shouldContain """url = "https://api.example.com/prod/aws-blocks/api""""
        source shouldContain """url = "http://localhost:3001/aws-blocks/api""""
    }

    test("reversing the declared order moves the default with it") {
        val twoServers = """
            [
              { "name": "local", "url": "http://localhost:3001" },
              { "name": "sandbox", "url": "https://api.example.com/prod" }
            ]
        """.trimIndent()

        val source = generate(spec(servers = twoServers))

        source shouldContain
            "public operator fun Blocks.Companion.invoke(): Blocks = Blocks(Servers.local)"
    }

    test("internal visibility covers the generated accessors too") {
        val source = generate(spec(), internalVisibility = true)

        source shouldContain "internal val Blocks.todos: Todos"
        source shouldContain "internal operator fun Blocks.Companion.invoke(): Blocks"
        source.contains("public val Blocks.") shouldBe false
        source.contains("public operator fun") shouldBe false
    }

    listOf("types" to "TypesApi", "serializers" to "SerializersApi", "servers" to "ServersApi")
        .forEach { (namespace, expected) ->
            test("a namespace named $namespace is renamed so it cannot overwrite a generated file") {
                val generated = result(
                    spec(namespaces = listOf(namespace, "todos"), withSharedType = true),
                )
                val names = generated.files.map { it.name }

                names shouldContain expected
                names shouldBe names.distinct()
                generated.warnings.single() shouldContain namespace
            }
        }

    test("a renamed namespace keeps a property name that matches its class") {
        val source = generate(spec(namespaces = listOf("types"), withSharedType = true))

        source shouldContain "public class TypesApi("
        source shouldContain "public val Blocks.typesApi: TypesApi\n  get() = TypesApi(client())"
    }

    test("a namespace that would collide with a renamed one fails rather than overwriting it") {
        val failure = runCatching {
            result(spec(namespaces = listOf("types", "typesApi"), withSharedType = true))
        }.exceptionOrNull()

        failure!!.message!! shouldContain "TypesApi"
    }
})
