package com.example.app

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.json.BlocksJson
import kotlin.Boolean
import kotlin.String
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement

public class Api(
  private val client: BlocksClient,
) {
  public suspend fun createUser(input: CreateUser.Input): CreateUser.Result {
    val request = BlocksRequest(method = "api.createUser", params = listOf(BlocksJson.encodeToJsonElement(input)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public object CreateUser {
    @Serializable
    public data class Result(
      public val ok: Boolean,
    )

    @Serializable
    public data class Input(
      public val email: String,
      public val code: String,
      public val nickname: String? = null,
    ) {
      init {
        require(email.length >= 5) { "email must be at least 5 characters" }
        require(email.length <= 254) { "email must be at most 254 characters" }
        require(code.matches(Regex("^[A-Z]{3}${'$'}"))) { "code must match pattern ^[A-Z]{3}$" }
        nickname?.let {
          require(it.length >= 2) { "nickname must be at least 2 characters" }
        }
        nickname?.let {
          require(it.length <= 30) { "nickname must be at most 30 characters" }
        }
      }
    }
  }
}

public val Blocks.api: Api
  get() = Api(client)
