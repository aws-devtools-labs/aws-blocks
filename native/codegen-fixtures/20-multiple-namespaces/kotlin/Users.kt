package com.example.app

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.exceptions.TransportException
import com.aws.blocks.kotlin.json.BlocksJson
import kotlin.String
import kotlin.collections.List
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement

public class Users(
  private val client: BlocksClient,
) {
  public suspend fun `get`(id: String): User {
    val request = BlocksRequest(method = "users.get", params = listOf(JsonPrimitive(id)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    if (result is JsonNull) throw TransportException("Unexpected null result for users.get")
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun list(): List<User> {
    val request = BlocksRequest(method = "users.list", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    if (result is JsonNull) throw TransportException("Unexpected null result for users.list")
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun create(input: Create.Input): User {
    val request = BlocksRequest(method = "users.create", params = listOf(BlocksJson.encodeToJsonElement(input)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    if (result is JsonNull) throw TransportException("Unexpected null result for users.create")
    return BlocksJson.decodeFromJsonElement(result)
  }

  public object Create {
    @Serializable
    public data class Input(
      public val name: String,
      public val email: String,
    )
  }
}

public val Blocks.users: Users
  get() = Users(client())
