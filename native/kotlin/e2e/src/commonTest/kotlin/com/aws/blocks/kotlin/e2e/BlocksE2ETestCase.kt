package com.aws.blocks.kotlin.e2e

import blocks.e2e.Api
import blocks.e2e.api
import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksServer

private val blocksUrl: String =
    getEnv("BLOCKS_URL")?.takeIf { it.isNotBlank() }
        ?: "http://localhost:3001/aws-blocks/api"

/**
 * One instance for the whole suite, so the tests run on a single HTTP client rather than one per
 * API. It is never closed: the engine goes away with the test process.
 */
private val blocks = Blocks(BlocksServer(name = "e2e", url = blocksUrl))

fun createApi(): Api = blocks.api

fun e2eBlocks(): Blocks = blocks
