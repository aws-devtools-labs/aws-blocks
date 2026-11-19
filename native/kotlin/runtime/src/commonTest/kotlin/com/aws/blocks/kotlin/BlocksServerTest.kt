// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.kotlin

import io.kotest.matchers.shouldBe
import kotlin.test.Test

/** [BlocksServer.rawRoute] resolves raw routes against the URL the RPC endpoint is served under. */
class BlocksServerTest {

    private fun route(url: String) = BlocksServer("s", url).rawRoute("/cdk-blocks/auth/session")

    @Test
    fun `keeps an API Gateway stage`() {
        route("https://x.execute-api.us-east-1.amazonaws.com/prod/cdk-blocks/api") shouldBe
            "https://x.execute-api.us-east-1.amazonaws.com/prod/cdk-blocks/auth/session"
    }

    @Test
    fun `uses the origin of a CloudFront front door`() {
        route("https://d1.cloudfront.net/cdk-blocks/api") shouldBe
            "https://d1.cloudfront.net/cdk-blocks/auth/session"
    }

    @Test
    fun `cuts a doubled RPC path at its first cdk-blocks segment`() {
        route("https://d1.cloudfront.net/cdk-blocks/api/cdk-blocks/api") shouldBe
            "https://d1.cloudfront.net/cdk-blocks/auth/session"
    }

    @Test
    fun `cuts at a legacy aws-blocks segment`() {
        route("https://host/prod/aws-blocks/api") shouldBe "https://host/prod/cdk-blocks/auth/session"
    }

    @Test
    fun `uses a bare origin as it is`() {
        route("http://localhost:3001") shouldBe "http://localhost:3001/cdk-blocks/auth/session"
        route("http://localhost:3001/") shouldBe "http://localhost:3001/cdk-blocks/auth/session"
    }

    @Test
    fun `cuts only at a whole cdk-blocks path segment`() {
        route("https://cdk-blocks.example.com/cdk-blocks/api") shouldBe
            "https://cdk-blocks.example.com/cdk-blocks/auth/session"
        route("https://example.com/cdk-blocks-staging/cdk-blocks/api") shouldBe
            "https://example.com/cdk-blocks-staging/cdk-blocks/auth/session"
    }
}
