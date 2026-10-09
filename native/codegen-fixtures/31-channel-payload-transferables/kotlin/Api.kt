package com.example.app

import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.BlocksServer
import com.aws.blocks.kotlin.filebucket.FileDownloadHandle
import com.aws.blocks.kotlin.json.BlocksJson
import com.aws.blocks.kotlin.realtime.RealtimeChannel
import kotlin.Deprecated
import kotlin.DeprecationLevel
import kotlin.Nothing
import kotlin.collections.List
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.decodeFromJsonElement

public class Api(
  private val server: BlocksServer = Servers.local,
) {
  private val client: BlocksClient = BlocksClient(server)

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

  public suspend fun getLobby(): Lobby {
    val request = BlocksRequest(method = "api.getLobby", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  @Deprecated(
    message = "OIDC is not configured. Add oidc { relayTo = \"...\" } to your awsBlocks block to enable this method.",
    level = DeprecationLevel.ERROR,
  )
  public suspend fun getSignInFeed(): Nothing = throw NotImplementedError("OIDC is not configured. Add oidc { relayTo = \"...\" } to your awsBlocks block to enable this method.")

  @Deprecated(
    message = "OIDC is not configured. Add oidc { relayTo = \"...\" } to your awsBlocks block to enable this method.",
    level = DeprecationLevel.ERROR,
  )
  public suspend fun getSignInBoard(): Nothing = throw NotImplementedError("OIDC is not configured. Add oidc { relayTo = \"...\" } to your awsBlocks block to enable this method.")

  @Deprecated(
    message = "OIDC is not configured. Add oidc { relayTo = \"...\" } to your awsBlocks block to enable this method.",
    level = DeprecationLevel.ERROR,
  )
  public suspend fun getProviderDirectory(): Nothing = throw NotImplementedError("OIDC is not configured. Add oidc { relayTo = \"...\" } to your awsBlocks block to enable this method.")
}
