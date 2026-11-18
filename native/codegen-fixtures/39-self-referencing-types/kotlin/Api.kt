package com.example.app

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.exceptions.TransportException
import com.aws.blocks.kotlin.json.BlocksJson
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement

public class Api(
  private val client: BlocksClient,
) {
  public suspend fun getTree(root: TreeNode): TreeNode {
    val request = BlocksRequest(method = "api.getTree", params = listOf(BlocksJson.encodeToJsonElement(root)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    if (result is JsonNull) throw TransportException("Unexpected null result for api.getTree")
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun getThread(): Comment {
    val request = BlocksRequest(method = "api.getThread", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    if (result is JsonNull) throw TransportException("Unexpected null result for api.getThread")
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun getCategory(): Category? {
    val request = BlocksRequest(method = "api.getCategory", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }
}

public val Blocks.api: Api
  get() = Api(client())
