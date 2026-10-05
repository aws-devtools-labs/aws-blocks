package com.example.app

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.filebucket.FileDownloadHandle
import com.aws.blocks.kotlin.filebucket.FileUploadHandle
import com.aws.blocks.kotlin.json.BlocksJson
import com.aws.blocks.kotlin.realtime.RealtimeChannel
import kotlin.Double
import kotlin.String
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement

public class Api(
  private val client: BlocksClient,
) {
  public suspend fun getChannel(): RealtimeChannel<GetChannel.Result> {
    val request = BlocksRequest(method = "api.getChannel", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return RealtimeChannel.fromJson(result) { BlocksJson.decodeFromJsonElement<GetChannel.Result>(it) }
  }

  public suspend fun getFile(path: String): FileDownloadHandle {
    val request = BlocksRequest(method = "api.getFile", params = listOf(JsonPrimitive(path)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return FileDownloadHandle.fromJson(result)
  }

  public suspend fun getUpload(path: String): FileUploadHandle {
    val request = BlocksRequest(method = "api.getUpload", params = listOf(JsonPrimitive(path)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return FileUploadHandle.fromJson(result)
  }

  public object GetChannel {
    @Serializable
    public data class Result(
      public val message: String,
      public val timestamp: Double,
    )
  }
}

public val Blocks.api: Api
  get() = Api(client)
