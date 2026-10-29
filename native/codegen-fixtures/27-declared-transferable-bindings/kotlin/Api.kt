package com.example.app

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.UnknownTransferable
import com.aws.blocks.kotlin.json.BlocksJson
import com.aws.blocks.kotlin.validateTransferableDescriptor
import com.example.blocks.gateway.GatewayLink
import com.example.blocks.iot.DeviceHandle
import com.example.blocks.iot.DeviceLink
import kotlin.Double
import kotlin.String
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement

public class Api(
  private val client: BlocksClient,
) {
  public suspend fun getDeviceHandle(deviceId: String): DeviceHandle {
    val request = BlocksRequest(method = "api.getDeviceHandle", params = listOf(JsonPrimitive(deviceId)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return DeviceHandle.fromBlocksDescriptor(validateTransferableDescriptor(result, expectedTag = "example-iot/device-handle"))
  }

  public suspend fun connectDevice(deviceId: String): DeviceLink<ConnectDevice.Result> {
    val request = BlocksRequest(method = "api.connectDevice", params = listOf(JsonPrimitive(deviceId)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return DeviceLink.fromBlocksDescriptor<ConnectDevice.Result>(validateTransferableDescriptor(result, expectedTag = "example-iot/device-link")) { BlocksJson.decodeFromJsonElement<ConnectDevice.Result>(it) }
  }

  public suspend fun findDeviceHandle(serialNumber: String): DeviceHandle {
    val request = BlocksRequest(method = "api.findDeviceHandle", params = listOf(JsonPrimitive(serialNumber)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return DeviceHandle.fromBlocksDescriptor(validateTransferableDescriptor(result, expectedTag = "example-iot/device-handle"))
  }

  public suspend fun openSensorStream(sensorId: String): UnknownTransferable {
    val request = BlocksRequest(method = "api.openSensorStream", params = listOf(JsonPrimitive(sensorId)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return UnknownTransferable.fromJson(result, expectedTag = "example-sensor/stream")
  }

  public suspend fun openGatewayLink(gatewayId: String): GatewayLink {
    val request = BlocksRequest(method = "api.openGatewayLink", params = listOf(JsonPrimitive(gatewayId)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return GatewayLink.fromBlocksDescriptor(validateTransferableDescriptor(result, expectedTag = "example-gateway/link"))
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

public val Blocks.api: Api
  get() = Api(client())
