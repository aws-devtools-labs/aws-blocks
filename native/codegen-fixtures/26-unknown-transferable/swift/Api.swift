import Foundation
import BlocksRuntime

public class Api {
    private let client: BlocksClient

    public init(server: BlocksServer = Servers.local) {
        self.client = BlocksClient(server: server)
    }

    /// Calls `api.getDeviceHandle`.
    public func getDeviceHandle(deviceId: String) async throws -> BlocksRuntime.UnknownTransferable {
        let request = BlocksRequest(method: "api.getDeviceHandle", params: [deviceId], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getDeviceHandle") }
        guard let descriptor = try JSONSerialization.jsonObject(with: result) as? [String: Any] else {
            throw RPCError(message: "Invalid transferable descriptor for api.getDeviceHandle")
        }
        return try BlocksRuntime.UnknownTransferable.fromJSON(descriptor, expectedTag: "example-iot/device-handle")
    }

    /// Calls `api.connectDevice`.
    public func connectDevice(deviceId: String) async throws -> BlocksRuntime.UnknownTransferable {
        let request = BlocksRequest(method: "api.connectDevice", params: [deviceId], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.connectDevice") }
        guard let descriptor = try JSONSerialization.jsonObject(with: result) as? [String: Any] else {
            throw RPCError(message: "Invalid transferable descriptor for api.connectDevice")
        }
        return try BlocksRuntime.UnknownTransferable.fromJSON(descriptor, expectedTag: "example-iot/device-link")
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
    public static let local = BlocksServer(name: "local", url: "http://localhost:3001/aws-blocks/api")
}