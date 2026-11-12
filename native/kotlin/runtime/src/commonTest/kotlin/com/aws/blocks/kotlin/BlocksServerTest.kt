package com.aws.blocks.kotlin

import io.kotest.matchers.shouldBe
import kotlin.test.Test

/** [BlocksServer.rawRoute] resolves raw routes against the URL the RPC endpoint is served under. */
class BlocksServerTest {

    private fun route(url: String) = BlocksServer("s", url).rawRoute("/aws-blocks/auth/session")

    @Test
    fun `keeps an API Gateway stage`() {
        route("https://x.execute-api.us-east-1.amazonaws.com/prod/aws-blocks/api") shouldBe
            "https://x.execute-api.us-east-1.amazonaws.com/prod/aws-blocks/auth/session"
    }

    @Test
    fun `uses the origin of a CloudFront front door`() {
        route("https://d1.cloudfront.net/aws-blocks/api") shouldBe
            "https://d1.cloudfront.net/aws-blocks/auth/session"
    }

    @Test
    fun `cuts a doubled RPC path at its first aws-blocks segment`() {
        route("https://d1.cloudfront.net/aws-blocks/api/aws-blocks/api") shouldBe
            "https://d1.cloudfront.net/aws-blocks/auth/session"
    }

    @Test
    fun `uses a bare origin as it is`() {
        route("http://localhost:3001") shouldBe "http://localhost:3001/aws-blocks/auth/session"
        route("http://localhost:3001/") shouldBe "http://localhost:3001/aws-blocks/auth/session"
    }

    @Test
    fun `cuts only at a whole aws-blocks path segment`() {
        route("https://aws-blocks.example.com/aws-blocks/api") shouldBe
            "https://aws-blocks.example.com/aws-blocks/auth/session"
        route("https://example.com/aws-blocks-staging/aws-blocks/api") shouldBe
            "https://example.com/aws-blocks-staging/aws-blocks/auth/session"
    }
}
