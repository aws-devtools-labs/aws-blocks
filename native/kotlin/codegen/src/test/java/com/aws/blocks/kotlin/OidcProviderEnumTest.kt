package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.builder.CodegenModelBuilder
import com.aws.blocks.kotlin.generator.GeneratorResult
import com.aws.blocks.kotlin.generator.KotlinCodeGenerator
import com.aws.blocks.kotlin.generator.RelayToRequirement
import com.aws.blocks.kotlin.parser.OpenRpcParser
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain

private const val RELAY_TO = "com.example.app://auth/callback"

private fun providerNames(vararg names: String): String =
    names.joinToString(", ") { "\"$it\"" }

/** An `oidc/client` result whose type argument names the providers it signs in with. */
private fun oidcResult(providers: String? = null, nullable: Boolean = false): String {
    val client = buildString {
        append("""{ "x-blocks-transferable": "oidc/client"""")
        if (providers != null) {
            append(""", "x-blocks-type-args": [ { "type": "string", "enum": [$providers] } ]""")
        }
        append(" }")
    }
    return if (nullable) """{ "oneOf": [ $client, { "type": "null" } ] }""" else client
}

private fun spec(
    resultSchema: String,
    params: String = "[]",
    components: String = "",
): String =
    """
    {
      "openrpc": "1.3.2",
      "info": { "title": "test", "version": "1.0.0" },
      "methods": [
        {
          "name": "auth.getClient",
          "params": $params,
          "result": { "name": "GetClientResult", "schema": $resultSchema }
        }
      ]$components
    }
    """.trimIndent()

private fun generate(
    spec: String,
    relayTo: String? = RELAY_TO,
    requirement: RelayToRequirement = RelayToRequirement.Required,
): GeneratorResult = KotlinCodeGenerator(
    packageName = "com.example.app",
    relayTo = relayTo,
    relayToRequirement = requirement,
).generate(CodegenModelBuilder().build(OpenRpcParser.parse(spec)))

private fun GeneratorResult.source(): String = files.joinToString("\n") { it.toString() }

class OidcProviderEnumTest : FunSpec({

    test("named providers type the client and generate an enum of their names") {
        val result = generate(spec(oidcResult(providerNames("google", "github"))))
        val source = result.source()

        source shouldContain "public suspend fun getClient(): OidcClient<GetClient.Provider>"
        source shouldContain "public enum class Provider("
        source shouldContain "override val providerName: String,"
        source shouldContain ") : OidcProvider {"
        source shouldContain "Google(\"google\")"
        source shouldContain "Github(\"github\")"
        source shouldContain "OidcClient.fromJson(result, client, \"$RELAY_TO\")"
        result.warnings shouldBe emptyList()
    }

    test("a spec that names no providers signs in with any string") {
        val source = generate(spec(oidcResult())).source()

        source shouldContain "public suspend fun getClient(): OidcClient<AnyProvider>"
        source shouldContain "OidcClient.fromJson(result, client, \"$RELAY_TO\")"
        source shouldNotContain "override val providerName"
        source shouldNotContain "enum class Provider"
    }

    test("an optional client keeps its providers") {
        val source = generate(spec(oidcResult(providerNames("google"), nullable = true))).source()

        source shouldContain "public suspend fun getClient(): OidcClient<GetClient.Provider>?"
        source shouldContain "else OidcClient.fromJson(result, client, \"$RELAY_TO\")"
    }

    test("a provider name no identifier can hold becomes one, and a repeat is dropped") {
        val source = generate(
            spec(oidcResult(providerNames("login.gov", "my-sso", "okta:corp", "2fa", "login.gov", "☃"))),
        ).source()

        // A name an identifier can't hold even backticked is rebuilt from its segments.
        source shouldContain "LoginGov(\"login.gov\")"
        source shouldContain "OktaCorp(\"okta:corp\")"
        // The rest keep the name the spec wrote, as every other generated enum does.
        source shouldContain "MySso(\"my-sso\")"
        source shouldContain "`2fa`(\"2fa\")"
        source shouldContain "`☃`(\"☃\")"
        // The repeated provider is emitted once, so the enum has one constant per name.
        Regex("LoginGov\\(").findAll(source).count() shouldBe 1
    }

    test("two providers that reduce to one name are numbered apart") {
        val source = generate(spec(oidcResult(providerNames("my-sso", "my.sso")))).source()

        source shouldContain "MySso(\"my-sso\")"
        source shouldContain "MySso2(\"my.sso\")"
    }

    test("an operation that already uses the name Provider renames the enum and says so") {
        val result = generate(
            spec(
                oidcResult(providerNames("google")),
                params = """[ { "name": "provider", "schema": { "type": "string", "enum": ["a", "b"] } } ]""",
            ),
        )
        val source = result.source()

        source shouldContain "public suspend fun getClient(provider: GetClient.Provider):" +
            " OidcClient<GetClient.ResultProvider>"
        source shouldContain "public enum class ResultProvider("
        result.warnings.single() shouldContain
            "auth.getClient generates Auth.GetClient.ResultProvider rather than Provider"
    }

    test("a component schema the operation names keeps its own type") {
        // The generator resolves an operation's types by name as well as by identity, so an enum
        // sharing a name with a schema the operation references would be handed back in its place.
        val result = generate(
            spec(
                oidcResult(providerNames("google")),
                params = """[ { "name": "hint", "schema": { "${'$'}ref": "#/components/schemas/Provider" } } ]""",
                components = """,
      "components": {
        "schemas": {
          "Provider": {
            "type": "object",
            "properties": { "label": { "type": "string" } },
            "required": ["label"]
          }
        }
      }""",
            ),
        )
        val source = result.source()

        source shouldContain "public suspend fun getClient(hint: Provider): OidcClient<GetClient.ResultProvider>"
        source shouldContain "public data class Provider("
        result.warnings.single() shouldContain "rather than Provider"
    }

    test("a client nested in another type gets no providers and no enum") {
        val source = generate(
            spec(
                """
                {
                  "type": "object",
                  "properties": { "client": ${oidcResult(providerNames("google"))} },
                  "required": ["client"]
                }
                """.trimIndent(),
            ),
        ).source()

        source shouldNotContain "enum class Provider"
        source shouldContain "OidcClient<AnyProvider>"
    }

    test("an unconfigured build stubs the method and emits no enum") {
        val source = generate(
            spec(oidcResult(providerNames("google"))),
            relayTo = null,
            requirement = RelayToRequirement.Required,
        ).source()

        source shouldContain "OIDC is not configured"
        source shouldNotContain "enum class Provider"
    }
})
