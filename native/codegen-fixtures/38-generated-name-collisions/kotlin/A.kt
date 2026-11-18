package com.example.app

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.exceptions.TransportException
import com.aws.blocks.kotlin.json.BlocksJson
import kotlin.String
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.decodeFromJsonElement

public class A(
  private val client: BlocksClient,
) {
  public suspend fun bPing(): String {
    val request = BlocksRequest(method = "a.b.ping", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    if (result is JsonNull) throw TransportException("Unexpected null result for a.b.ping")
    return BlocksJson.decodeFromJsonElement(result)
  }
}

public val Blocks.a: A
  get() = A(client())
