import Foundation
import BlocksRuntime
import ExampleIotNative
import ExampleSensorNative

public class Api {
    private let client: BlocksRuntime.BlocksClient

    public init(server: BlocksRuntime.BlocksServer = Servers.local) {
        self.client = BlocksRuntime.BlocksClient(server: server)
    }

    /// Calls `api.getDeviceHandle`.
    public func getDeviceHandle(deviceId: String) async throws -> ExampleIotNative.DeviceHandle {
        let request = BlocksRuntime.BlocksRequest(method: "api.getDeviceHandle", params: [deviceId], id: BlocksRuntime.BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw BlocksRuntime.RPCError(message: "Unexpected null result for api.getDeviceHandle") }
        guard let descriptor = try JSONSerialization.jsonObject(with: result) as? [String: Any] else {
            throw BlocksRuntime.RPCError(message: "Invalid transferable descriptor for api.getDeviceHandle")
        }
        return try ExampleIotNative.DeviceHandle.fromBlocksDescriptor(
            BlocksRuntime.validateTransferableDescriptor(descriptor, expectedTag: "example-iot/device-handle")
        )
    }

    /// Calls `api.connectDevice`.
    public func connectDevice(deviceId: String) async throws -> ExampleIotNative.DeviceLink<ConnectDevice.ResultMessage> {
        let request = BlocksRuntime.BlocksRequest(method: "api.connectDevice", params: [deviceId], id: BlocksRuntime.BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw BlocksRuntime.RPCError(message: "Unexpected null result for api.connectDevice") }
        guard let descriptor = try JSONSerialization.jsonObject(with: result) as? [String: Any] else {
            throw BlocksRuntime.RPCError(message: "Invalid transferable descriptor for api.connectDevice")
        }
        return try ExampleIotNative.DeviceLink<ConnectDevice.ResultMessage>.fromBlocksDescriptor(
            BlocksRuntime.validateTransferableDescriptor(descriptor, expectedTag: "example-iot/device-link")
        ) { data in
            try JSONDecoder().decode(ConnectDevice.ResultMessage.self, from: data)
        }
    }

    /// Calls `api.findDeviceHandle`.
    public func findDeviceHandle(serialNumber: String) async throws -> ExampleIotNative.DeviceHandle {
        let request = BlocksRuntime.BlocksRequest(method: "api.findDeviceHandle", params: [serialNumber], id: BlocksRuntime.BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw BlocksRuntime.RPCError(message: "Unexpected null result for api.findDeviceHandle") }
        guard let descriptor = try JSONSerialization.jsonObject(with: result) as? [String: Any] else {
            throw BlocksRuntime.RPCError(message: "Invalid transferable descriptor for api.findDeviceHandle")
        }
        return try ExampleIotNative.DeviceHandle.fromBlocksDescriptor(
            BlocksRuntime.validateTransferableDescriptor(descriptor, expectedTag: "example-iot/device-handle")
        )
    }

    /// Calls `api.openSensorStream`.
    public func openSensorStream(sensorId: String) async throws -> ExampleSensorNative.SensorStream {
        let request = BlocksRuntime.BlocksRequest(method: "api.openSensorStream", params: [sensorId], id: BlocksRuntime.BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw BlocksRuntime.RPCError(message: "Unexpected null result for api.openSensorStream") }
        guard let descriptor = try JSONSerialization.jsonObject(with: result) as? [String: Any] else {
            throw BlocksRuntime.RPCError(message: "Invalid transferable descriptor for api.openSensorStream")
        }
        return try ExampleSensorNative.SensorStream.fromBlocksDescriptor(
            BlocksRuntime.validateTransferableDescriptor(descriptor, expectedTag: "example-sensor/stream")
        )
    }

    /// Calls `api.openGatewayLink`.
    public func openGatewayLink(gatewayId: String) async throws -> BlocksRuntime.UnknownTransferable {
        let request = BlocksRuntime.BlocksRequest(method: "api.openGatewayLink", params: [gatewayId], id: BlocksRuntime.BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw BlocksRuntime.RPCError(message: "Unexpected null result for api.openGatewayLink") }
        guard let descriptor = try JSONSerialization.jsonObject(with: result) as? [String: Any] else {
            throw BlocksRuntime.RPCError(message: "Invalid transferable descriptor for api.openGatewayLink")
        }
        return try BlocksRuntime.UnknownTransferable.fromJSON(descriptor, expectedTag: "example-gateway/link")
    }

    /// Calls `api.getFirmwareSession`.
    public func getFirmwareSession(deviceId: String) async throws -> BlocksRuntime.UnknownTransferable {
        let request = BlocksRuntime.BlocksRequest(method: "api.getFirmwareSession", params: [deviceId], id: BlocksRuntime.BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw BlocksRuntime.RPCError(message: "Unexpected null result for api.getFirmwareSession") }
        guard let descriptor = try JSONSerialization.jsonObject(with: result) as? [String: Any] else {
            throw BlocksRuntime.RPCError(message: "Invalid transferable descriptor for api.getFirmwareSession")
        }
        return try BlocksRuntime.UnknownTransferable.fromJSON(descriptor, expectedTag: "example-iot/firmware-session")
    }

    public enum ConnectDevice {

        public struct ResultMessage: Codable {
            public let humidity: Double
            public let temperature: Double
        }
    }
}


// MARK: - Servers

public enum Servers {
    public static let local = BlocksRuntime.BlocksServer(name: "local", url: "http://localhost:3001/aws-blocks/api")
}