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

public class Api(
  private val client: BlocksClient,
) {
  public suspend fun getOrganization(id: String): GetOrganization.Result {
    val request = BlocksRequest(method = "api.getOrganization", params = listOf(JsonPrimitive(id)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun createOrganization(input: CreateOrganization.Input): CreateOrganization.Result {
    val request = BlocksRequest(method = "api.createOrganization", params = listOf(BlocksJson.encodeToJsonElement(input)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun updateOrganization(input: UpdateOrganization.Input): UpdateOrganization.Result {
    val request = BlocksRequest(method = "api.updateOrganization", params = listOf(BlocksJson.encodeToJsonElement(input)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public object GetOrganization {
    @Serializable
    public data class Result(
      public val id: String,
      public val name: String,
      public val address: Result.Address,
      public val owner: Result.Owner,
    ) {
      @Serializable
      public data class Address(
        public val street: String,
        public val city: String,
        public val contact: Address.Contact,
      ) {
        @Serializable
        public data class Contact(
          public val email: String,
        )
      }

      @Serializable
      public data class Owner(
        public val name: String,
        public val contact: Owner.Contact,
      ) {
        @Serializable
        public data class Contact(
          public val email: String,
          public val phone: String,
        )
      }
    }
  }

  public object CreateOrganization {
    @Serializable
    public data class Result(
      public val id: String,
    )

    @Serializable
    public data class Input(
      public val name: String,
      public val address: Input.Address,
      public val owner: Input.Owner,
    ) {
      @Serializable
      public data class Address(
        public val street: String,
        public val city: String,
        public val countryCode: String,
      )

      @Serializable
      public data class Owner(
        public val name: String,
        public val email: String,
      )
    }
  }

  public object UpdateOrganization {
    @Serializable
    public data class Result(
      public val ok: Boolean,
    )

    @Serializable
    public data class Input(
      public val id: String,
      public val name: String? = null,
      public val address: Input.Address? = null,
      public val owner: Input.Owner? = null,
    ) {
      @Serializable
      public data class Address(
        public val street: String,
        public val city: String,
        public val zip: String,
      )

      @Serializable
      public data class Owner(
        public val name: String,
        public val contact: Owner.Contact,
      ) {
        @Serializable
        public data class Contact(
          public val email: String,
          public val phone: String,
        )
      }
    }
  }
}

public val Blocks.api: Api
  get() = Api(client)
