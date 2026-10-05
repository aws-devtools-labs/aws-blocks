package com.example.app

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.json.BlocksJson
import kotlin.Boolean
import kotlin.String
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement

public class Posts(
  private val client: BlocksClient,
) {
  public suspend fun list(authorId: String): kotlin.collections.List<List.Result> {
    val request = BlocksRequest(method = "posts.list", params = listOf(JsonPrimitive(authorId)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun create(input: Create.Input): Create.Result {
    val request = BlocksRequest(method = "posts.create", params = listOf(BlocksJson.encodeToJsonElement(input)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun delete(id: String): Delete.Result {
    val request = BlocksRequest(method = "posts.delete", params = listOf(JsonPrimitive(id)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public object List {
    @Serializable
    public data class Result(
      public val id: String,
      public val title: String,
      public val authorId: String,
    )
  }

  public object Create {
    @Serializable
    public data class Result(
      public val id: String,
      public val title: String,
      public val authorId: String,
    )

    @Serializable
    public data class Input(
      public val title: String,
      public val body: String,
      public val authorId: String,
    )
  }

  public object Delete {
    @Serializable
    public data class Result(
      public val ok: Boolean,
    )
  }
}

public val Blocks.posts: Posts
  get() = Posts(client)
