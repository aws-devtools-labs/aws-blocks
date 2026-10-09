package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.filebucket.FileDownloadHandle
import com.aws.blocks.kotlin.filebucket.FileUploadHandle
import com.aws.blocks.kotlin.oidc.OidcClient
import com.aws.blocks.kotlin.realtime.RealtimeChannel
import io.kotest.matchers.shouldBe
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import kotlin.test.Test
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

/**
 * A generated client sends a transferable parameter as its `{ "__blocks": … }` descriptor, the
 * shape the server's `toJSON()` sends and `fromJson` reads, as Swift's `encode(to:)` does.
 * A hydrated transferable encodes the descriptor it came from.
 */
class TransferableToJsonTest {

    private fun parse(text: String): JsonElement = Json.parseToJsonElement(text)

    private val httpClient = HttpClient(MockEngine) { engine { addHandler { respond("{}") } } }
    private val server = BlocksServer("local", "http://localhost:3001")

    @Test
    fun `a channel encodes the descriptor it was hydrated from`() {
        val descriptor = parse(
            """{"__blocks":"realtime/channel","channel":"room-1","wsUrl":"wss://rt.example/ws","connectToken":"ct","token":"tk"}""",
        )
        val channel = RealtimeChannel.fromJson(descriptor) { it }
        channel.wsUrl shouldBe "wss://rt.example/ws?token=ct"
        channel.toJson() shouldBe descriptor
    }

    @Test
    fun `a channel without a connect token omits it`() {
        val descriptor = parse("""{"__blocks":"realtime/channel","channel":"c","wsUrl":"ws://localhost:3001","token":"t"}""")
        RealtimeChannel.fromJson(descriptor) { it }.toJson() shouldBe descriptor
    }

    @Test
    fun `a channel built directly encodes its fields`() {
        val channel = RealtimeChannel(channel = "c", wsUrl = "wss://x", token = "t", deserializer = { it })
        channel.toJson() shouldBe parse("""{"__blocks":"realtime/channel","channel":"c","wsUrl":"wss://x","token":"t"}""")
    }

    @Test
    fun `file handles encode their descriptors`() {
        val download = parse("""{"__blocks":"file-bucket/download","url":"https://s3/get"}""")
        FileDownloadHandle.fromJson(download).toJson() shouldBe download

        val upload = parse("""{"__blocks":"file-bucket/upload","url":"https://s3/put","contentType":"image/png"}""")
        FileUploadHandle.fromJson(upload).toJson() shouldBe upload

        val untyped = parse("""{"__blocks":"file-bucket/upload","url":"https://s3/put"}""")
        FileUploadHandle.fromJson(untyped).toJson() shouldBe untyped
    }

    @Test
    fun `an OIDC client encodes the descriptor it was hydrated from`() {
        val descriptor = parse(
            """
            {"__blocks":"oidc/client","providers":["google"],"providerConfigs":{},
             "exchangePath":"/auth/exchange","signOutPath":"/auth/signout","signInBasePath":"/auth/signin",
             "authorizeParamsBasePath":"/auth/authorize-params","callbackPath":"/auth/callback","futureKey":1}
            """.trimIndent(),
        )
        OidcClient.fromJson(descriptor, httpClient, server, "app://cb").toJson() shouldBe descriptor
    }

    @Test
    fun `an OIDC client built for an auth block encodes its configuration`() {
        OidcClient.forAuth(httpClient, server, providers = listOf("google"), relayTo = "app://cb").toJson() shouldBe parse(
            """
            {"__blocks":"oidc/client","providers":["google"],"providerConfigs":{},
             "exchangePath":"/aws-blocks/auth/exchange","signOutPath":"/aws-blocks/auth/signout",
             "signInBasePath":"/aws-blocks/auth/signin","authorizeParamsBasePath":"/aws-blocks/auth/authorize-params",
             "callbackPath":"/aws-blocks/auth/callback"}
            """.trimIndent(),
        )
    }
}
