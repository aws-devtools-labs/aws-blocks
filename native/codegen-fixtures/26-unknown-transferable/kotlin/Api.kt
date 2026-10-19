package com.example.app

import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.BlocksServer
import com.aws.blocks.kotlin.UnknownTransferable
import kotlin.Double
import kotlin.String
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive

public class Api(
  private val server: BlocksServer = Servers.local,
) {
  private val client: BlocksClient = BlocksClient(server)

  public suspend fun getDeviceHandle(deviceId: String): UnknownTransferable {
    val request = BlocksRequest(method = "api.getDeviceHandle", params = listOf(JsonPrimitive(deviceId)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return UnknownTransferable.fromJson(result, expectedTag = "example-iot/device-handle")
  }

  public suspend fun connectDevice(deviceId: String): UnknownTransferable {
    val request = BlocksRequest(method = "api.connectDevice", params = listOf(JsonPrimitive(deviceId)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return UnknownTransferable.fromJson(result, expectedTag = "example-iot/device-link")
  }

  public object ConnectDevice {
    @Serializable
    public data class Result(
      public val temperature: Double,
      public val humidity: Double,
    )
  }
}
