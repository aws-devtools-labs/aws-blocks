package com.example.app

import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.BlocksServer
import com.aws.blocks.kotlin.json.BlocksJson
import kotlin.Double
import kotlin.String
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement

public class Api(
  private val server: BlocksServer = Servers.local,
) {
  private val client: BlocksClient = BlocksClient(server)

  public suspend fun send(
    request: String,
    `class`: String,
    args: String? = null,
    json: String? = null,
  ): Send.Result {
    val args_2 = mutableListOf<JsonElement>(JsonPrimitive(request), JsonPrimitive(`class`))
    if (args != null || json != null) {
      args_2.add(if (args != null) JsonPrimitive(args) else JsonNull)
    }
    if (json != null) {
      args_2.add(JsonPrimitive(json))
    }
    val request_2 = BlocksRequest(method = "api.send", params = args_2, id = BlocksRequest.nextId())
    val result = client.execute(request_2)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun getProfile(profile: Profile): Profile {
    val request = BlocksRequest(method = "api.getProfile", params = listOf(BlocksJson.encodeToJsonElement(profile)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun one(): One.Result {
    val request = BlocksRequest(method = "api.one", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun two(): Two.Result {
    val request = BlocksRequest(method = "api.two", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun relay(client: String): String {
    val request = BlocksRequest(method = "api.relay", params = listOf(JsonPrimitive(client)), id = BlocksRequest.nextId())
    val result = this.client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun putBag(bag: Bag): Bag {
    val request = BlocksRequest(method = "api.putBag", params = listOf(BlocksJson.encodeToJsonElement(bag)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun getWeird(weird: Weird): Weird {
    val request = BlocksRequest(method = "api.getWeird", params = listOf(BlocksJson.encodeToJsonElement(weird)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public object Send {
    @Serializable
    public data class Result(
      public val sent: String,
    )
  }

  public object One {
    @Serializable
    public data class Result(
      public val a: String,
    )
  }

  public object Two {
    @Serializable
    public data class Result(
      public val b: Double,
    )
  }
}
