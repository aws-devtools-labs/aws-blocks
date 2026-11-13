package com.example.app

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.json.BlocksJson
import kotlin.Int
import kotlin.String
import kotlin.collections.List
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement

public class Api(
  private val client: BlocksClient,
) {
  /**
   * An operation whose name and parameters are not identifiers
   */
  public suspend fun getSampleX(
    `run { error("xParam") } || p`: String,
    item: SampleTypeX,
    optIonal: Int? = null,
  ): SampleTypeX {
    val args: List<JsonElement> = if (optIonal != null) listOf(JsonPrimitive(`run { error("xParam") } || p`), BlocksJson.encodeToJsonElement(item), JsonPrimitive(optIonal)) else listOf(JsonPrimitive(`run { error("xParam") } || p`), BlocksJson.encodeToJsonElement(item))
    val request = BlocksRequest(method = "api.get\"Sample`;x", params = args, id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }
}

public val Blocks.api: Api
  get() = Api(client())
