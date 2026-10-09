package com.aws.blocks.kotlin.oidc

import com.aws.blocks.kotlin.BlocksServer
import com.aws.blocks.kotlin.json.BlocksJson
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.matchers.shouldBe
import io.kotest.matchers.types.shouldBeSameInstanceAs
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import kotlin.test.Test
import kotlinx.serialization.Contextual
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject

/** Shaped like a generated model: every [OidcClient] is `@Contextual`, at any depth. */
@Serializable
private data class SignInOption(val label: String, @Contextual val client: OidcClient)

@Serializable
private data class LoginMenu(
    val primary: SignInOption,
    val options: List<SignInOption>,
    val byName: Map<String, @Contextual OidcClient>,
    val clients: List<@Contextual OidcClient?>,
    @Contextual val fallback: OidcClient? = null,
)

/**
 * [OidcClient.json] decodes an `oidc/client` transferable wherever it sits in a model. A model
 * holding one used to throw `Unknown transferable: oidc/client` (R52).
 */
class OidcClientJsonTest {

    private val descriptor = """
        {"__blocks":"oidc/client","providers":["google"],"providerConfigs":{},
         "exchangePath":"/auth/exchange","signOutPath":"/auth/signout","signInBasePath":"/auth/signin",
         "authorizeParamsBasePath":"/auth/authorize-params","callbackPath":"/auth/callback"}
    """.trimIndent()

    private val menu = """
        {"primary":{"label":"G","client":$descriptor},"options":[{"label":"A","client":$descriptor}],
         "byName":{"g":$descriptor},"clients":[$descriptor,null]}
    """.trimIndent()

    private val httpClient = HttpClient(MockEngine) { engine { addHandler { respond("{}") } } }
    private val server = BlocksServer("local", "http://localhost:3001")

    @Test
    // No commas in the name: Kotlin/Native rejects them in a backtick-quoted declaration name, so a comma
    // here breaks `compileTestKotlinIosSimulatorArm64` while the JVM target compiles fine.
    fun `hydrates every OIDC client in a model bound to the calling client and relay target`() {
        val json = OidcClient.json(httpClient, server, "myapp://auth/callback")
        val decoded = json.decodeFromJsonElement<LoginMenu>(Json.parseToJsonElement(menu))

        val clients = listOf(decoded.primary.client, decoded.options.single().client, decoded.byName.getValue("g")) +
            decoded.clients.filterNotNull()
        clients.size shouldBe 4
        for (client in clients) {
            client.providers shouldBe listOf("google")
            client.config.relayTo shouldBe "myapp://auth/callback"
            client.config.callbackPath shouldBe "/auth/callback"
            client.httpClient shouldBeSameInstanceAs httpClient
            client.server shouldBeSameInstanceAs server
        }
        decoded.clients[1] shouldBe null
        decoded.fallback shouldBe null
    }

    @Test
    fun `decodes a list of OIDC clients returned directly`() {
        val json = OidcClient.json(httpClient, server, "myapp://auth/callback")
        val decoded = json.decodeFromJsonElement<List<OidcClient>>(Json.parseToJsonElement("[$descriptor]"))
        decoded.single().providers shouldBe listOf("google")
    }

    @Test
    fun `keeps BlocksJson's leniency`() {
        val json = OidcClient.json(httpClient, server, "r")
        val withExtra = menu.replaceFirst("{\"primary\"", "{\"unknownKey\":1,\"primary\"")
        json.decodeFromJsonElement<LoginMenu>(Json.parseToJsonElement(withExtra)).options.size shouldBe 1
    }

    @Test
    fun `encodes every OIDC client in a model as its descriptor`() {
        // A generated client sends a model holding OIDC clients (a parameter) this way.
        val json = OidcClient.json(httpClient, server, "r")
        val decoded = json.decodeFromJsonElement<LoginMenu>(Json.parseToJsonElement(menu))
        json.encodeToJsonElement(decoded.primary) shouldBe Json.parseToJsonElement("""{"label":"G","client":$descriptor}""")
        val encoded = json.encodeToJsonElement(decoded).jsonObject
        encoded.getValue("byName") shouldBe Json.parseToJsonElement("""{"g":$descriptor}""")
        encoded.getValue("clients") shouldBe Json.parseToJsonElement("[$descriptor,null]")
    }

    @Test
    fun `plain BlocksJson has no OIDC client to bind to`() {
        shouldThrow<SerializationException> {
            BlocksJson.decodeFromJsonElement<LoginMenu>(Json.parseToJsonElement(menu))
        }
    }
}
