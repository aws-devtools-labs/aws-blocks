package com.aws.blocks.kotlin

import io.kotest.matchers.shouldBe
import kotlin.test.Test

/**
 * The per-namespace RPC path.
 *
 * A JSON-RPC call goes to `{server.url}/{namespace}` so a front door can route
 * each namespace to the compute that hosts it. The namespace also stays in the
 * request body, which is what the server dispatches on, so the path is purely a
 * routing hint.
 */
class BlocksClientTest {
    private fun client(url: String) = BlocksClient(BlocksServer(name = "test", url = url))

    @Test
    fun appendsTheNamespaceAsAPathSegment() {
        client("http://localhost:3001/aws-blocks/api").rpcUrl("orders.list").toString() shouldBe
            "http://localhost:3001/aws-blocks/api/orders"
    }

    @Test
    fun routesDistinctNamespacesToDistinctPaths() {
        // The point of the segment: without it every namespace would hit one path
        // and a front door could not fan out to per-namespace computes.
        val c = client("http://localhost:3001/aws-blocks/api")
        c.rpcUrl("orders.list").toString() shouldBe "http://localhost:3001/aws-blocks/api/orders"
        c.rpcUrl("authApi.signIn").toString() shouldBe "http://localhost:3001/aws-blocks/api/authApi"
    }

    @Test
    fun keepsTheStagePrefix() {
        client("https://abc.execute-api.us-east-1.amazonaws.com/prod/aws-blocks/api")
            .rpcUrl("orders.list").toString() shouldBe
            "https://abc.execute-api.us-east-1.amazonaws.com/prod/aws-blocks/api/orders"
    }

    @Test
    fun toleratesATrailingSlashWithoutDoublingIt() {
        client("http://localhost:3001/aws-blocks/api/").rpcUrl("orders.list").toString() shouldBe
            "http://localhost:3001/aws-blocks/api/orders"
    }

    @Test
    fun leavesAnUnNamespacedMethodAtTheBaseUrl() {
        // The generator emits a bare method name for un-namespaced operations;
        // there is no segment to add, and the server serves the base RPC path.
        client("http://localhost:3001/aws-blocks/api").rpcUrl("ping").toString() shouldBe
            "http://localhost:3001/aws-blocks/api"
    }

    @Test
    fun usesOnlyTheFirstSegmentOfADottedMethod() {
        client("http://localhost:3001/aws-blocks/api").rpcUrl("orders.items.list").toString() shouldBe
            "http://localhost:3001/aws-blocks/api/orders"
    }

    @Test
    fun leavesTheServerUrlUntouchedSoRawRoutesStillResolve() {
        // Raw routes and the auth flow derive their base by stripping /aws-blocks
        // from server.url. Appending the namespace must not mutate that.
        val c = client("http://localhost:3001/aws-blocks/api")
        c.rpcUrl("orders.list")
        c.server.url.toString() shouldBe "http://localhost:3001/aws-blocks/api"
        c.server.rawRoute("aws-blocks", "auth", "callback") shouldBe
            "http://localhost:3001/aws-blocks/auth/callback"
    }
}
