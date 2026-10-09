package com.aws.blocks.kotlin.e2e

import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.exceptions.ApiException
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import kotlinx.coroutines.test.runTest
import kotlin.test.Test

/**
 * The JSON-RPC wire contract the generated client relies on, against the real server
 * (`parseRpcRequest` and the namespace / method lookup in `packages/core`).
 *
 * Params are positional: the server calls the method with `params` as its argument list. A
 * generated call that leaves out an optional argument before a set one sends `null` in its slot,
 * as the TypeScript client does, so `echoArgs("a", last = "c")` reaches the server as
 * `echoArgs("a", null, "c")`. The base generator sent `["a","c"]`, which the server read as
 * `middle = "c"` (FX45, R81).
 */
class RpcWireE2ETest {

    private val api = createApi()

    @Test
    fun leftOutMiddleOptionalKeepsTheLaterArgumentInItsSlot() = runTest {
        val echoed = api.echoArgs("a", last = "c")
        echoed.first shouldBe "a"
        echoed.middle.shouldBeNull()
        echoed.last shouldBe "c"
    }

    @Test
    fun everyArgumentSetArrivesInOrder() = runTest {
        val echoed = api.echoArgs("a", "b", "c")
        echoed.first shouldBe "a"
        echoed.middle shouldBe "b"
        echoed.last shouldBe "c"
    }

    @Test
    fun trailingUnsetArgumentsAreLeftOff() = runTest {
        val onlyFirst = api.echoArgs("a")
        onlyFirst.middle.shouldBeNull()
        onlyFirst.last.shouldBeNull()
        val firstTwo = api.echoArgs("a", middle = "b")
        firstTwo.middle shouldBe "b"
        firstTwo.last.shouldBeNull()
    }

    /**
     * A spec's method name is sent exactly. The server has no method without a dot: it answers
     * one with `InvalidRequest`, so a hand-written spec's dotless `ping` can't reach an AWS
     * Blocks backend from any client. The base generator sent it as `_default.ping`, which the
     * server reads as the method `ping` of an export named `_default`.
     */
    @Test
    fun serverAcceptsOnlyNamespaceDotMethod() = runTest {
        val client = BlocksClient(e2eServer())
        val dotless = shouldThrow<ApiException> {
            client.execute(BlocksRequest(method = "echoArgs", params = emptyList(), id = BlocksRequest.nextId()))
        }
        dotless.name shouldBe "InvalidRequest"
        dotless.code shouldBe -32600

        val defaultNamespace = shouldThrow<ApiException> {
            client.execute(BlocksRequest(method = "_default.echoArgs", params = emptyList(), id = BlocksRequest.nextId()))
        }
        defaultNamespace.code shouldBe -32601
        defaultNamespace.message shouldContain "API '_default' not found"
    }
}
