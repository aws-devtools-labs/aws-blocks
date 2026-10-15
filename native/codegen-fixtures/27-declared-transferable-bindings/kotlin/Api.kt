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

  public suspend fun findDeviceHandle(serialNumber: String): UnknownTransferable {
    val request = BlocksRequest(method = "api.findDeviceHandle", params = listOf(JsonPrimitive(serialNumber)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return UnknownTransferable.fromJson(result, expectedTag = "example-iot/device-handle")
  }

  public suspend fun openSensorStream(sensorId: String): UnknownTransferable {
    val request = BlocksRequest(method = "api.openSensorStream", params = listOf(JsonPrimitive(sensorId)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return UnknownTransferable.fromJson(result, expectedTag = "example-sensor/stream")
  }

  public suspend fun openGatewayLink(gatewayId: String): UnknownTransferable {
    val request = BlocksRequest(method = "api.openGatewayLink", params = listOf(JsonPrimitive(gatewayId)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return UnknownTransferable.fromJson(result, expectedTag = "example-gateway/link")
  }

  public suspend fun getFirmwareSession(deviceId: String): UnknownTransferable {
    val request = BlocksRequest(method = "api.getFirmwareSession", params = listOf(JsonPrimitive(deviceId)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return UnknownTransferable.fromJson(result, expectedTag = "example-iot/firmware-session")
  }

  public object ConnectDevice {
    @Serializable
    public data class Result(
      public val temperature: Double,
      public val humidity: Double,
    )
  }
}
