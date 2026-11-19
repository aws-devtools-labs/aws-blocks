// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.kotlin.exceptions

import io.kotest.matchers.shouldBe
import kotlin.test.Test

class ApiExceptionTest {

    @Test
    fun `carries the status and name and retriable flag`() {
        val e = ApiException("Username already taken", 409, "ConditionalCheckFailedException", retriable = true)
        e.message shouldBe "Username already taken"
        e.status shouldBe 409
        e.name shouldBe "ConditionalCheckFailedException"
        e.retriable shouldBe true
    }

    @Test
    fun `name and retriable default to absent`() {
        val e = ApiException("Internal error", 500)
        e.name shouldBe null
        e.retriable shouldBe false
    }

    @Test
    fun `isBlocksError matches on the name only`() {
        val e: Throwable = ApiException("nope", 409, "ConditionalCheckFailedException")
        e.isBlocksError("ConditionalCheckFailedException") shouldBe true
        e.isBlocksError("SomeOtherException") shouldBe false
        RuntimeException("not ours").isBlocksError("ConditionalCheckFailedException") shouldBe false
        ApiException("nameless", 500).isBlocksError("ConditionalCheckFailedException") shouldBe false
    }
}
