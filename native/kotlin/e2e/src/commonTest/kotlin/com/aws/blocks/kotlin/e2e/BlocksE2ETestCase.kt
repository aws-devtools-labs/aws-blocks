package com.aws.blocks.kotlin.e2e

import blocks.e2e.Api
import com.aws.blocks.kotlin.BlocksServer

private val blocksUrl: String =
    getEnv("BLOCKS_URL")?.takeIf { it.isNotBlank() }
        ?: "http://localhost:3001/aws-blocks/api"

private val server = BlocksServer(name = "e2e", url = blocksUrl)

fun createApi(): Api = Api(server = server)
