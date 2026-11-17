package com.example.app

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.filebucket.FileDownloadHandle
import com.aws.blocks.kotlin.json.BlocksJson
import com.aws.blocks.kotlin.oidc.OidcClient
import com.aws.blocks.kotlin.realtime.RealtimeChannel
import kotlin.Double
import kotlin.String
import kotlin.collections.List
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.decodeFromJsonElement

public class Api(
  private val client: BlocksClient,
) {
  public suspend fun getAttachmentFeed(): RealtimeChannel<Attachment> {
    val request = BlocksRequest(method = "api.getAttachmentFeed", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return RealtimeChannel.fromJson(result) { BlocksJson.decodeFromJsonElement<Attachment>(it) }
  }

  public suspend fun getDownloadFeed(): RealtimeChannel<List<FileDownloadHandle>> {
    val request = BlocksRequest(method = "api.getDownloadFeed", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return RealtimeChannel.fromJson(result) { BlocksJson.decodeFromJsonElement(ListSerializer(FileDownloadHandleSerializer), it) }
  }

  public suspend fun getChatFeed(): GetChatFeed.Result {
    val request = BlocksRequest(method = "api.getChatFeed", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun getCounterFeed(): GetCounterFeed.Result {
    val request = BlocksRequest(method = "api.getCounterFeed", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun getLobby(): Lobby {
    val request = BlocksRequest(method = "api.getLobby", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun getSignInFeed(): RealtimeChannel<SignInOption> {
    val request = BlocksRequest(method = "api.getSignInFeed", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    val json = OidcClient.json(client, "blocks-fixture://auth")
    return RealtimeChannel.fromJson(result) { json.decodeFromJsonElement<SignInOption>(it) }
  }

  public suspend fun getSignInBoard(): SignInBoard {
    val request = BlocksRequest(method = "api.getSignInBoard", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return OidcClient.json(client, "blocks-fixture://auth").decodeFromJsonElement(result)
  }

  public suspend fun getProviderDirectory(): ProviderDirectory {
    val request = BlocksRequest(method = "api.getProviderDirectory", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return OidcClient.json(client, "blocks-fixture://auth").decodeFromJsonElement(result)
  }

  public object GetChatFeed {
    @Serializable
    public data class Result(
      @Serializable(with = RealtimeChannelApiGetChatFeedResultChannelSerializer::class)
      public val channel: RealtimeChannel<Result.Channel>,
    ) {
      @Serializable
      public data class Channel(
        public val text: String,
      )
    }
  }

  public object GetCounterFeed {
    @Serializable
    public data class Result(
      @Serializable(with = RealtimeChannelApiGetCounterFeedResultChannelSerializer::class)
      public val channel: RealtimeChannel<Result.Channel>,
    ) {
      @Serializable
      public data class Channel(
        public val count: Double,
      )
    }
  }
}

public val Blocks.api: Api
  get() = Api(client())
