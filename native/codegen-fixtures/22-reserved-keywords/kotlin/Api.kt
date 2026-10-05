package com.example.app

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.json.BlocksJson
import kotlin.Boolean
import kotlin.Int
import kotlin.String
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement

public class Api(
  private val client: BlocksClient,
) {
  public suspend fun getClass(id: String): GetClass.Result {
    val request = BlocksRequest(method = "api.getClass", params = listOf(JsonPrimitive(id)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun `import`(input: Import.Input): Import.Result {
    val request = BlocksRequest(method = "api.import", params = listOf(BlocksJson.encodeToJsonElement(input)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun export(): Export.Result {
    val request = BlocksRequest(method = "api.export", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public object GetClass {
    @Serializable
    public data class Result(
      public val type: String,
      @SerialName("class")
      public val `class`: String,
      public val default: String,
      @SerialName("in")
      public val `in`: String,
      @SerialName("is")
      public val `is`: Boolean,
      @SerialName("return")
      public val `return`: Int,
      @SerialName("var")
      public val `var`: String,
      @SerialName("val")
      public val `val`: String,
      @SerialName("when")
      public val `when`: String,
      public val switch: String,
      public val self: String,
      @SerialName("super")
      public val `super`: String,
    )
  }

  public object Import {
    @Serializable
    public data class Result(
      public val ok: Boolean,
    )

    @Serializable
    public data class Input(
      @SerialName("for")
      public val `for`: String,
      @SerialName("while")
      public val `while`: Int,
      @SerialName("do")
      public val `do`: Boolean,
      @SerialName("else")
      public val `else`: String,
      public val `enum`: String,
      public val extends: String,
      public val `final`: String,
      public val `abstract`: Boolean,
    )
  }

  public object Export {
    @Serializable
    public data class Result(
      @SerialName("object")
      public val `object`: String,
      @SerialName("package")
      public val `package`: String,
      public val `internal`: String,
      public val `operator`: String,
      @SerialName("this")
      public val `this`: String,
      @SerialName("throw")
      public val `throw`: String,
      @SerialName("true")
      public val `true`: Boolean,
      @SerialName("false")
      public val `false`: Boolean,
      @SerialName("null")
      public val `null`: String,
    )
  }
}

public val Blocks.api: Api
  get() = Api(client)
