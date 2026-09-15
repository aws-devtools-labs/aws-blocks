package com.example.app

import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.BlocksServer
import com.aws.blocks.kotlin.json.BlocksJson
import com.aws.blocks.kotlin.realtime.RealtimeChannel
import kotlin.Int
import kotlin.String
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.decodeFromJsonElement

public class Api(
  private val server: BlocksServer = Servers.local,
) {
  private val client: BlocksClient = BlocksClient(server)

  public suspend fun getSession(): GetSession.Result {
    val request = BlocksRequest(method = "api.getSession", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun getOtherSession(): GetOtherSession.Result {
    val request = BlocksRequest(method = "api.getOtherSession", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public object GetSession {
    @Serializable
    public data class Result(
      public val sessionId: String,
      @Serializable(with = RealtimeChannelApiGetSessionResultChannelSerializer::class)
      public val channel: RealtimeChannel<Result.Channel>,
    ) {
      @Serializable
      public data class Channel(
        public val text: String,
      )
    }
  }

  public object GetOtherSession {
    @Serializable
    public data class Result(
      @Serializable(with = RealtimeChannelApiGetOtherSessionResultChannelSerializer::class)
      public val channel: RealtimeChannel<Result.Channel>,
    ) {
      @Serializable
      public data class Channel(
        public val count: Int,
      )
    }
  }
}
