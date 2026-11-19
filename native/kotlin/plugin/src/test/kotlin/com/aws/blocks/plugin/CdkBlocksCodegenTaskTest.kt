// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.plugin

import com.aws.blocks.kotlin.generator.RelayToRequirement
import com.aws.blocks.kotlin.CodegenException
import com.aws.blocks.kotlin.parser.OpenRpcParseException
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import io.kotest.matchers.types.shouldBeInstanceOf
import org.gradle.api.GradleException
import org.gradle.testfixtures.ProjectBuilder
import java.io.File
import java.net.URISyntaxException

private const val UNSUPPORTED_SCHEMA_VERSION = """
{
  "openrpc": "1.3.2",
  "info": { "title": "test", "version": "1.0.0" },
  "methods": [],
  "x-blocks-native-packages": { "schemaVersion": 2, "packages": {} }
}
"""

private const val ARITY_MISMATCH = """
{
  "openrpc": "1.3.2",
  "info": { "title": "test", "version": "1.0.0" },
  "methods": [ { "name": "api.connectDevice", "params": [], "result": { "name": "R",
    "schema": { "oneOf": [ { "x-blocks-transferable": "example-iot/device-link" }, { "type": "null" } ] } } } ],
  "x-blocks-native-packages": { "schemaVersion": 1, "packages": { "p": { "platforms": {
    "android": { "package": { "group": "g", "artifact": "a", "kotlinPackage": "com.example.blocks.iot" } } } } } },
  "x-blocks-native-bindings": { "schemaVersion": 1, "bindings": [ { "id": "b", "kind": "transferable",
    "tag": "example-iot/device-link", "package": "p", "export": "deviceLink",
    "abi": "blocks-transferable-v1", "genericArity": 1 } ] }
}
"""

private const val BOUND_SPEC = """
{
  "openrpc": "1.3.2",
  "info": { "title": "test", "version": "1.0.0" },
  "methods": [ { "name": "api.connectDevice", "params": [], "result": { "name": "R",
    "schema": { "x-blocks-transferable": "example-iot/device-link" } } } ],
  "x-blocks-native-packages": { "schemaVersion": 1, "packages": { "example-iot-native": { "platforms": {
    "android": { "package": { "group": "g", "artifact": "a", "kotlinPackage": "com.example.blocks.iot" } } } } } },
  "x-blocks-native-bindings": { "schemaVersion": 1, "bindings": [ { "id": "b", "kind": "transferable",
    "tag": "example-iot/device-link", "package": "example-iot-native", "export": "deviceLink",
    "abi": "blocks-transferable-v1", "genericArity": 0 } ] }
}
"""

private const val UNDEFINED_KIND = """
{
  "openrpc": "1.3.2",
  "info": { "title": "test", "version": "1.0.0" },
  "methods": [ { "name": "api.connectDevice", "params": [], "result": { "name": "R",
    "schema": { "x-blocks-transferable": "example-iot/device-link" } } } ],
  "x-blocks-native-packages": { "schemaVersion": 1, "packages": { "example-iot-native": { "platforms": {
    "android": { "package": { "group": "g", "artifact": "a", "kotlinPackage": "com.example.blocks.iot" } } } } } },
  "x-blocks-native-bindings": { "schemaVersion": 1, "bindings": [ { "id": "typo", "kind": "transferrable",
    "tag": "example-iot/device-link", "package": "example-iot-native", "export": "deviceLink",
    "abi": "blocks-transferable-v1", "genericArity": 0 } ] }
}
"""

private const val EMPTY_SPEC = """
{
  "openrpc": "1.3.2",
  "info": { "title": "test", "version": "1.0.0" },
  "methods": []
}
"""

private const val SPEC_WITH_LOCAL_SERVER = """
{
  "openrpc": "1.3.2",
  "info": { "title": "test", "version": "1.0.0" },
  "servers": [ { "name": "local", "url": "http://localhost:3001/cdk-blocks/api" } ],
  "methods": []
}
"""

private class StaleOutput(
    spec: String,
    excluded: Set<String> = emptySet(),
    servers: Map<String, String> = emptyMap(),
) {
    private val project = ProjectBuilder.builder().build()
    val outputDir: File = File(project.projectDir, "generated").apply { mkdirs() }
    val previous: File = File(outputDir, "Api.kt").apply { writeText("// from the previous run") }

    fun generatedApi(): String = File(outputDir, "com/example/app/Api.kt").readText()

    fun generatedServers(): String = File(outputDir, "com/example/app/Servers.kt").readText()

    val task: CdkBlocksCodegenTask = project.tasks
        .register("probe", CdkBlocksCodegenTask::class.java).get().apply {
            openRpcFile.set(File(project.projectDir, "blocks.spec.json").apply { writeText(spec) })
            packageName.set("com.example.app")
            serverOverrides.set(servers)
            excludeNativePackages.set(excluded)
            visibility.set(GeneratedVisibility.Public)
            relayToRequirement.set(RelayToRequirement.NotNeeded)
            outputDirectory.set(outputDir)
        }
}

class CdkBlocksCodegenTaskTest : FunSpec({

    test("a rejected spec leaves previously generated sources in place") {
        val run = StaleOutput(UNSUPPORTED_SCHEMA_VERSION)

        shouldThrow<OpenRpcParseException> { run.task.generate() }

        run.previous.readText() shouldBe "// from the previous run"
    }

    test("a spec rejected during code generation leaves previously generated sources in place") {
        val run = StaleOutput(ARITY_MISMATCH)

        shouldThrow<CodegenException> { run.task.generate() }

        run.previous.readText() shouldBe "// from the previous run"
    }

    test("an accepted spec replaces previously generated sources") {
        val run = StaleOutput(EMPTY_SPEC)

        run.task.generate()

        run.previous.exists() shouldBe false
    }

    test("an accepted spec writes the generated client into the output directory") {
        val run = StaleOutput(BOUND_SPEC)

        run.task.generate()

        run.generatedApi() shouldContain "import com.example.blocks.iot.DeviceLink"
        run.generatedApi() shouldContain "): DeviceLink {"
    }

    test("a binding of an undefined kind still generates through the task") {
        val run = StaleOutput(UNDEFINED_KIND)

        run.task.generate()

        run.generatedApi() shouldContain "): UnknownTransferable {"
        run.generatedApi() shouldNotContain "import com.example.blocks.iot.DeviceLink"
    }

    test("an excluded package identity reaches the generator and keeps the fallback") {
        val run = StaleOutput(BOUND_SPEC, excluded = setOf("example-iot-native"))

        run.task.generate()

        run.generatedApi() shouldContain "): UnknownTransferable {"
        run.generatedApi() shouldNotContain "fromBlocksDescriptor"
    }

    test("a server override with no path is rejected") {
        val run = StaleOutput(SPEC_WITH_LOCAL_SERVER, servers = mapOf("local" to "http://10.0.2.2:3001"))

        val error = shouldThrow<GradleException> { run.task.generate() }

        error.message shouldContain "cdkBlocks.servers: \"local\" is \"http://10.0.2.2:3001\", which has no RPC path"
        error.message shouldContain "for example \"http://10.0.2.2:3001/cdk-blocks/api\""
        error.message shouldContain "the spec declares \"local\" as \"http://localhost:3001/cdk-blocks/api\""
        run.previous.readText() shouldBe "// from the previous run"
    }

    test("every override is checked, not only the first or the last") {
        val servers = linkedMapOf(
            "local" to "http://10.0.2.2:3001/cdk-blocks/api",
            "staging" to "https://staging.example.com",
            "prod" to "https://prod.example.com/cdk-blocks/api",
        )
        val run = StaleOutput(SPEC_WITH_LOCAL_SERVER, servers = servers)

        val error = shouldThrow<GradleException> { run.task.generate() }

        error.message shouldContain "\"staging\" is \"https://staging.example.com\", which has no RPC path"
    }

    test("a trailing-slash override is rejected, pointing at its own deployment when the spec lacks the name") {
        val run = StaleOutput(SPEC_WITH_LOCAL_SERVER, servers = mapOf("staging" to "https://staging.example.com/"))

        val error = shouldThrow<GradleException> { run.task.generate() }

        error.message shouldContain "\"staging\" is \"https://staging.example.com/\", which has no RPC path"
        error.message shouldContain "for example \"https://staging.example.com/cdk-blocks/api\""
        error.message shouldContain "the dev server writes it to .cdk-blocks-sandbox/config.json, " +
            "a sandbox or production deploy to .cdk-blocks-sandbox/config.<stage>.json"
    }

    test("a server override with only slashes for a path is rejected") {
        val run = StaleOutput(SPEC_WITH_LOCAL_SERVER, servers = mapOf("local" to "http://10.0.2.2:3001//"))

        val error = shouldThrow<GradleException> { run.task.generate() }

        error.message shouldContain "\"local\" is \"http://10.0.2.2:3001//\", which has no RPC path"
        error.message shouldContain "for example \"http://10.0.2.2:3001/cdk-blocks/api\""
    }

    test("a server override whose path is only a dot is rejected") {
        val run = StaleOutput(SPEC_WITH_LOCAL_SERVER, servers = mapOf("local" to "http://10.0.2.2:3001/."))

        val error = shouldThrow<GradleException> { run.task.generate() }

        error.message shouldContain "\"local\" is \"http://10.0.2.2:3001/.\", which has no RPC path"
        error.message shouldContain "for example \"http://10.0.2.2:3001/cdk-blocks/api\""
    }

    test("a server override whose path climbs to the root is rejected") {
        val run = StaleOutput(SPEC_WITH_LOCAL_SERVER, servers = mapOf("local" to "http://10.0.2.2:3001/.."))

        val error = shouldThrow<GradleException> { run.task.generate() }

        error.message shouldContain "\"local\" is \"http://10.0.2.2:3001/..\", which has no RPC path"
        error.message shouldContain "for example \"http://10.0.2.2:3001/cdk-blocks/api\""
    }

    test("a server override whose path climbs back to the root is rejected") {
        val run = StaleOutput(SPEC_WITH_LOCAL_SERVER, servers = mapOf("local" to "http://10.0.2.2:3001/a/.."))

        val error = shouldThrow<GradleException> { run.task.generate() }

        error.message shouldContain "\"local\" is \"http://10.0.2.2:3001/a/..\", which has no RPC path"
        error.message shouldContain "for example \"http://10.0.2.2:3001/cdk-blocks/api\""
    }

    test("a server override whose only path segment is an encoded slash is rejected") {
        val run = StaleOutput(SPEC_WITH_LOCAL_SERVER, servers = mapOf("local" to "http://10.0.2.2:3001/%2F"))

        val error = shouldThrow<GradleException> { run.task.generate() }

        error.message shouldContain "\"local\" is \"http://10.0.2.2:3001/%2F\", which has no RPC path"
        error.message shouldContain "for example \"http://10.0.2.2:3001/cdk-blocks/api\""
    }

    test("a server override whose only path segment is an encoded dot is rejected") {
        val run = StaleOutput(SPEC_WITH_LOCAL_SERVER, servers = mapOf("local" to "http://10.0.2.2:3001/%2E"))

        val error = shouldThrow<GradleException> { run.task.generate() }

        error.message shouldContain "\"local\" is \"http://10.0.2.2:3001/%2E\", which has no RPC path"
        error.message shouldContain "for example \"http://10.0.2.2:3001/cdk-blocks/api\""
    }

    test("a server override that is not a URL is rejected") {
        val run = StaleOutput(SPEC_WITH_LOCAL_SERVER, servers = mapOf("local" to "http://[::1"))

        val error = shouldThrow<GradleException> { run.task.generate() }

        val cause = error.cause.shouldBeInstanceOf<URISyntaxException>()
        error.message shouldContain
            "\"local\" is \"http://[::1\", which is not a valid URL (${cause.reason}). Use the full RPC URL"
        error.message shouldContain
            "Use the full RPC URL (the spec declares \"local\" as \"http://localhost:3001/cdk-blocks/api\")"
    }

    test("a server override with no host is rejected") {
        val run = StaleOutput(SPEC_WITH_LOCAL_SERVER, servers = mapOf("local" to "http:foo"))

        val error = shouldThrow<GradleException> { run.task.generate() }

        error.message shouldContain "\"local\" is \"http:foo\", which has no host"
        error.message shouldContain
            "Use the full RPC URL (the spec declares \"local\" as \"http://localhost:3001/cdk-blocks/api\")"
    }

    test("a server override with a path but no host is rejected") {
        val run = StaleOutput(SPEC_WITH_LOCAL_SERVER, servers = mapOf("local" to "http:/h/cdk-blocks/api"))

        val error = shouldThrow<GradleException> { run.task.generate() }

        error.message shouldContain "\"local\" is \"http:/h/cdk-blocks/api\", which has no host"
        error.message shouldContain
            "Use the full RPC URL (the spec declares \"local\" as \"http://localhost:3001/cdk-blocks/api\")"
    }

    test("a server override with a port but no host is rejected") {
        val run = StaleOutput(SPEC_WITH_LOCAL_SERVER, servers = mapOf("local" to "http://:3001/cdk-blocks/api"))

        val error = shouldThrow<GradleException> { run.task.generate() }

        error.message shouldContain "\"local\" is \"http://:3001/cdk-blocks/api\", which has no host"
    }

    test("a server override with user info but no host is rejected") {
        val run = StaleOutput(SPEC_WITH_LOCAL_SERVER, servers = mapOf("local" to "http://u@:3001/cdk-blocks/api"))

        val error = shouldThrow<GradleException> { run.task.generate() }

        error.message shouldContain "\"local\" is \"http://u@:3001/cdk-blocks/api\", which has no host"
    }

    test("a server override without an http scheme is rejected even when it carries the RPC path") {
        val run = StaleOutput(SPEC_WITH_LOCAL_SERVER, servers = mapOf("local" to "localhost:3001/cdk-blocks/api"))

        val error = shouldThrow<GradleException> { run.task.generate() }

        error.message shouldContain
            "\"local\" is \"localhost:3001/cdk-blocks/api\", which has no http:// or https:// scheme"
        error.message shouldContain
            "Use the full RPC URL (the spec declares \"local\" as \"http://localhost:3001/cdk-blocks/api\")"
    }

    test("a server override with a non-http scheme is rejected even when it carries the RPC path") {
        val run = StaleOutput(SPEC_WITH_LOCAL_SERVER, servers = mapOf("local" to "ftp://10.0.2.2:3001/cdk-blocks/api"))

        val error = shouldThrow<GradleException> { run.task.generate() }

        error.message shouldContain
            "\"local\" is \"ftp://10.0.2.2:3001/cdk-blocks/api\", which has no http:// or https:// scheme"
    }

    test("a scheme-relative server override is rejected") {
        val run = StaleOutput(SPEC_WITH_LOCAL_SERVER, servers = mapOf("local" to "//10.0.2.2:3001/cdk-blocks/api"))

        val error = shouldThrow<GradleException> { run.task.generate() }

        error.message shouldContain
            "\"local\" is \"//10.0.2.2:3001/cdk-blocks/api\", which has no http:// or https:// scheme"
    }

    test("a server override with a query is rejected") {
        val withQuery = "http://10.0.2.2:3001/cdk-blocks/api?x=1"
        val run = StaleOutput(SPEC_WITH_LOCAL_SERVER, servers = mapOf("local" to withQuery))

        val error = shouldThrow<GradleException> { run.task.generate() }

        error.message shouldContain
            "cdkBlocks.servers: \"local\" is \"$withQuery\", which carries a query or fragment"
        error.message shouldContain "A server URL is the RPC base the client posts to, so give the URL without them"
        error.message shouldContain "(the spec declares \"local\" as \"http://localhost:3001/cdk-blocks/api\")"
    }

    test("a server override with a fragment is rejected") {
        val withFragment = "http://10.0.2.2:3001/cdk-blocks/api#f"
        val run = StaleOutput(SPEC_WITH_LOCAL_SERVER, servers = mapOf("local" to withFragment))

        val error = shouldThrow<GradleException> { run.task.generate() }

        error.message shouldContain
            "cdkBlocks.servers: \"local\" is \"$withFragment\", which carries a query or fragment"
        error.message shouldContain "A server URL is the RPC base the client posts to, so give the URL without them"
        error.message shouldContain "(the spec declares \"local\" as \"http://localhost:3001/cdk-blocks/api\")"
    }

    test("a server override carrying the RPC path replaces the spec server as written") {
        val run = StaleOutput(SPEC_WITH_LOCAL_SERVER, servers = mapOf("local" to "http://10.0.2.2:3001/cdk-blocks/api"))

        run.task.generate()

        run.generatedServers() shouldContain "url = \"http://10.0.2.2:3001/cdk-blocks/api\""
        run.generatedServers() shouldNotContain "localhost:3001"
    }

    test("a server override with an upper-case http scheme is accepted") {
        val run = StaleOutput(SPEC_WITH_LOCAL_SERVER, servers = mapOf("local" to "HTTP://10.0.2.2:3001/cdk-blocks/api"))

        run.task.generate()

        run.generatedServers() shouldContain "url = \"HTTP://10.0.2.2:3001/cdk-blocks/api\""
    }

    test("a server override with an upper-case https scheme is accepted") {
        val upperCased = "HTTPS://10.0.2.2:3001/cdk-blocks/api"
        val run = StaleOutput(SPEC_WITH_LOCAL_SERVER, servers = mapOf("local" to upperCased))

        run.task.generate()

        run.generatedServers() shouldContain "url = \"$upperCased\""
    }

    test("a server override with an underscore host is accepted") {
        val run = StaleOutput(SPEC_WITH_LOCAL_SERVER, servers = mapOf("local" to "http://my_host:3001/cdk-blocks/api"))

        run.task.generate()

        run.generatedServers() shouldContain "url = \"http://my_host:3001/cdk-blocks/api\""
    }

    test("a server override with an IPv6 host is accepted") {
        val run = StaleOutput(SPEC_WITH_LOCAL_SERVER, servers = mapOf("local" to "http://[::1]:3001/cdk-blocks/api"))

        run.task.generate()

        run.generatedServers() shouldContain "url = \"http://[::1]:3001/cdk-blocks/api\""
    }

    test("a server override with a single path segment is accepted") {
        val run = StaleOutput(SPEC_WITH_LOCAL_SERVER, servers = mapOf("local" to "http://10.0.2.2:3001/api"))

        run.task.generate()

        run.generatedServers() shouldContain "url = \"http://10.0.2.2:3001/api\""
    }

    test("a server override with a stage prefix before the RPC path is accepted") {
        val staged = "https://x.execute-api.us-east-1.amazonaws.com/prod/cdk-blocks/api"
        val run = StaleOutput(SPEC_WITH_LOCAL_SERVER, servers = mapOf("prod" to staged))

        run.task.generate()

        run.generatedServers() shouldContain "url = \"$staged\""
    }

    test("an override carrying the RPC path is written once, not appended to again") {
        val run = StaleOutput(SPEC_WITH_LOCAL_SERVER, servers = mapOf("local" to "http://10.0.2.2:3001/cdk-blocks/api"))

        run.task.generate()

        run.generatedServers() shouldNotContain "/cdk-blocks/api/cdk-blocks/api"
    }
})
