package com.example.app.roundtrip

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksServer
import com.aws.blocks.kotlin.json.BlocksJson
import com.example.app.Api
import com.example.app.Category
import com.example.app.Comment
import com.example.app.Product
import com.example.app.TreeNode
import com.sun.net.httpserver.HttpServer
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.net.InetSocketAddress

private fun json(text: String): JsonElement = Json.parseToJsonElement(text)

/**
 * A JSON-RPC server on a free port that answers each method with [results] and records every
 * request it receives. [block] runs with a client for the server; the server stops afterwards.
 */
private fun withServer(results: Map<String, String>, block: (BlocksClient) -> Unit): List<JsonObject> {
    val received = mutableListOf<JsonObject>()
    val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    server.createContext("/") { exchange ->
        val request = Json.parseToJsonElement(exchange.requestBody.readBytes().decodeToString()).jsonObject
        received.add(request)
        val result = results.getValue(request.getValue("method").jsonPrimitive.content)
        val body = """{"jsonrpc":"2.0","id":${request["id"]},"result":$result}""".encodeToByteArray()
        exchange.responseHeaders.add("Content-Type", "application/json")
        exchange.sendResponseHeaders(200, body.size.toLong())
        exchange.responseBody.use { it.write(body) }
    }
    server.start()
    try {
        block(Blocks(BlocksServer(name = "local", url = "http://127.0.0.1:${server.address.port}")).client())
    } finally {
        server.stop(0)
    }
    return received
}

/**
 * Fixture 39: component schemas that refer to themselves (`TreeNode.children`, `Comment.replies`)
 * or to each other (`Category` and `Product`). The base generator overflowed the stack expanding
 * them; here each is one class that holds its own type, and nested wire JSON round-trips.
 */
class SelfReferencingTypesRoundTripTest : FunSpec({

    test("a tree of TreeNode decodes and encodes at every level, through the list and the map") {
        val wire = json(
            """{"label":"root","children":[{"label":"a","children":[{"label":"a1","children":[]}]}],""" +
                """"byName":{"b":{"label":"b","children":[]}}}""",
        )
        val tree = TreeNode(
            label = "root",
            children = listOf(TreeNode(label = "a", children = listOf(TreeNode(label = "a1", children = emptyList())))),
            byName = mapOf("b" to TreeNode(label = "b", children = emptyList())),
        )
        BlocksJson.decodeFromJsonElement(TreeNode.serializer(), wire) shouldBe tree
        BlocksJson.encodeToJsonElement(TreeNode.serializer(), tree) shouldBe wire
    }

    test("getTree() sends the tree as its parameter and decodes the tree it gets back") {
        val reply = """{"label":"r","children":[{"label":"c","children":[]}]}"""
        val received = withServer(mapOf("api.getTree" to reply)) { client ->
            runBlocking {
                Api(client).getTree(TreeNode(label = "q", children = listOf(TreeNode(label = "q1", children = emptyList())))) shouldBe
                    TreeNode(label = "r", children = listOf(TreeNode(label = "c", children = emptyList())))
            }
        }
        received.single().getValue("params").jsonArray.single() shouldBe
            json("""{"label":"q","children":[{"label":"q1","children":[]}]}""")
    }

    test("getThread() decodes nested replies, and a null replies") {
        val reply = """{"text":"t","replies":[{"text":"r1","replies":[{"text":"r2","replies":null}]}]}"""
        withServer(mapOf("api.getThread" to reply)) { client ->
            runBlocking {
                Api(client).getThread() shouldBe Comment(
                    text = "t",
                    replies = listOf(Comment(text = "r1", replies = listOf(Comment(text = "r2", replies = null)))),
                )
            }
        }
    }

    test("getCategory() decodes mutually recursive Category and Product, and null") {
        val reply = """{"name":"c","products":[{"sku":"p","categories":[{"name":"d","products":[]}]}]}"""
        withServer(mapOf("api.getCategory" to reply)) { client ->
            runBlocking {
                Api(client).getCategory() shouldBe Category(
                    name = "c",
                    products = listOf(Product(sku = "p", categories = listOf(Category(name = "d", products = emptyList())))),
                )
            }
        }
        withServer(mapOf("api.getCategory" to "null")) { client ->
            runBlocking { Api(client).getCategory() shouldBe null }
        }
    }
})
