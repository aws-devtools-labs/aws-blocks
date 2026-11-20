// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.kotlin.e2e

import blocks.e2e.api
import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.exceptions.ApiException
import com.aws.blocks.kotlin.exceptions.ClientClosedException
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
 * `middle = "c"`.
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
     * The server answers a method that returns nothing with `"result": null`. A response with no
     * `result` field made the client throw "Missing result field in JSON-RPC response".
     */
    @Test
    fun voidMethodReturns() = runTest {
        api.voidResult()
    }

    /**
     * A spec's method name is sent exactly. The server has no method without a dot: it answers
     * one with `InvalidRequest`, so a hand-written spec's dotless `ping` can't reach a
     * CDK Blocks backend from any client. The base generator sent it as `_default.ping`, which the
     * server reads as the method `ping` of an export named `_default`.
     */
    @Test
    fun serverAcceptsOnlyNamespaceDotMethod() = runTest {
        val client = e2eBlocks().client()
        val dotless = shouldThrow<ApiException> {
            client.execute(BlocksRequest(method = "echoArgs", params = emptyList(), id = BlocksRequest.nextId()))
        }
        dotless.name shouldBe "InvalidRequest"
        dotless.status shouldBe 500

        val defaultNamespace = shouldThrow<ApiException> {
            client.execute(BlocksRequest(method = "_default.echoArgs", params = emptyList(), id = BlocksRequest.nextId()))
        }
        defaultNamespace.name shouldBe "MethodNotFound"
        defaultNamespace.status shouldBe 500
        defaultNamespace.message shouldContain "API '_default' not found"
    }

    /**
     * A call through a closed `Blocks` reports the closed state rather than failing inside the
     * HTTP engine with a cancellation the caller can't tell from its own. Uses its own instance:
     * the suite's shared one is never closed.
     */
    @Test
    fun callAfterCloseThrowsClientClosedException() = runTest {
        val blocks = Blocks(e2eServer())
        val closedApi = blocks.api
        closedApi.echoArgs("before close").first shouldBe "before close"

        blocks.close()

        shouldThrow<ClientClosedException> { closedApi.echoArgs("after close") }
    }
}
