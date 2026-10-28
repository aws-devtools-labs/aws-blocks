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
        source shouldContain "public val providerName: String,"
        source shouldContain "Google(\"google\")"
        source shouldContain "Github(\"github\")"
        source shouldContain "The providers `auth.getClient` signs in with."
        source shouldContain "OidcClient.fromJson(result, client, \"$RELAY_TO\") { it.providerName }"
        result.warnings shouldBe emptyList()
    }

    test("a spec that names no providers signs in with any string") {
        val source = generate(spec(oidcResult())).source()

        source shouldContain "public suspend fun getClient(): OidcClient<String>"
        source shouldContain "OidcClient.fromJson(result, client, \"$RELAY_TO\")"
        source shouldNotContain "providerName"
        source shouldNotContain "enum class Provider"
    }

    test("an optional client keeps its providers") {
        val source = generate(spec(oidcResult(providerNames("google"), nullable = true))).source()

        source shouldContain "public suspend fun getClient(): OidcClient<GetClient.Provider>?"
        source shouldContain "else OidcClient.fromJson(result, client, \"$RELAY_TO\") { it.providerName }"
    }

    test("a provider name that is not an identifier becomes one, and a repeat is dropped") {
        val source = generate(
            spec(oidcResult(providerNames("login.gov", "my-sso", "okta:corp", "2fa", "login.gov", "☃"))),
        ).source()

        source shouldContain "LoginGov(\"login.gov\")"
        source shouldContain "MySso(\"my-sso\")"
        source shouldContain "OktaCorp(\"okta:corp\")"
        source shouldContain "_2fa(\"2fa\")"
        source shouldContain "Unnamed(\"☃\")"
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
            "auth.getClient names its providers Auth.GetClient.ResultProvider"
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
        source shouldContain "OidcClient<String>"
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
