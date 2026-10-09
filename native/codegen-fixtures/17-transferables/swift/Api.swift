import Foundation
import BlocksRuntime

public class Api {
    private let client: BlocksClient

    public init(server: BlocksServer = Servers.local) {
        self.client = BlocksClient(server: server)
    }

    /// Calls `api.getChannel`.
    public func getChannel() async throws -> RealtimeChannel<GetChannel.ResultMessage> {
        let request = BlocksRequest(method: "api.getChannel", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getChannel") }
        guard let descriptor = try JSONSerialization.jsonObject(with: result) as? [String: Any] else {
            throw RPCError(message: "Invalid channel descriptor for api.getChannel")
        }
        return RealtimeChannel<GetChannel.ResultMessage>.fromJSON(descriptor, baseHost: BlocksClient.baseHost) { data in
            try JSONDecoder().decode(GetChannel.ResultMessage.self, from: data)
        }
    }

    /// Calls `api.getFile`.
    public func getFile(path: String) async throws -> FileDownloadHandle {
        let request = BlocksRequest(method: "api.getFile", params: [path], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getFile") }
        guard let descriptor = try JSONSerialization.jsonObject(with: result) as? [String: Any] else {
            throw RPCError(message: "Invalid file descriptor for api.getFile")
        }
        return try FileDownloadHandle.fromJSON(descriptor)
    }

    /// Calls `api.getUpload`.
    public func getUpload(path: String) async throws -> FileUploadHandle {
        let request = BlocksRequest(method: "api.getUpload", params: [path], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getUpload") }
        guard let descriptor = try JSONSerialization.jsonObject(with: result) as? [String: Any] else {
            throw RPCError(message: "Invalid file descriptor for api.getUpload")
        }
        return try FileUploadHandle.fromJSON(descriptor)
    }

    public enum GetChannel {

        public struct ResultMessage: Codable {
            public let message: String
            public let timestamp: Double
        }
    }
}


// MARK: - Servers

public enum Servers {
    public static let local = BlocksServer(name: "local", url: "http://localhost:3001/aws-blocks/api")
}