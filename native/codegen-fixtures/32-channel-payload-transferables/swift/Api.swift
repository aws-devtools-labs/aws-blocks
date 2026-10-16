import Foundation
import BlocksRuntime

public class Api {
    private let client: BlocksClient

    public init(server: BlocksServer = Servers.local) {
        self.client = BlocksClient(server: server)
    }

    /// Calls `api.getAttachmentFeed`.
    public func getAttachmentFeed() async throws -> RealtimeChannel<Attachment> {
        let request = BlocksRequest(method: "api.getAttachmentFeed", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getAttachmentFeed") }
        guard let descriptor = try JSONSerialization.jsonObject(with: result) as? [String: Any] else {
            throw RPCError(message: "Invalid channel descriptor for api.getAttachmentFeed")
        }
        return RealtimeChannel<Attachment>.fromJSON(descriptor, baseHost: BlocksClient.baseHost) { data in
            try JSONDecoder().decode(Attachment.self, from: data)
        }
    }

    /// Calls `api.getDownloadFeed`.
    public func getDownloadFeed() async throws -> RealtimeChannel<[FileDownloadHandle]> {
        let request = BlocksRequest(method: "api.getDownloadFeed", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getDownloadFeed") }
        guard let descriptor = try JSONSerialization.jsonObject(with: result) as? [String: Any] else {
            throw RPCError(message: "Invalid channel descriptor for api.getDownloadFeed")
        }
        return RealtimeChannel<[FileDownloadHandle]>.fromJSON(descriptor, baseHost: BlocksClient.baseHost) { data in
            try JSONDecoder().decode([FileDownloadHandle].self, from: data)
        }
    }

    /// Calls `api.getLobby`.
    public func getLobby() async throws -> Lobby {
        let request = BlocksRequest(method: "api.getLobby", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getLobby") }
        return try JSONDecoder().decode(Lobby.self, from: result)
    }

    /// Calls `api.getSignInFeed`.
    public func getSignInFeed() async throws -> RealtimeChannel<SignInOption> {
        let request = BlocksRequest(method: "api.getSignInFeed", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getSignInFeed") }
        guard let descriptor = try JSONSerialization.jsonObject(with: result) as? [String: Any] else {
            throw RPCError(message: "Invalid channel descriptor for api.getSignInFeed")
        }
        return RealtimeChannel<SignInOption>.fromJSON(descriptor, baseHost: BlocksClient.baseHost) { [client] data in
            try client.makeDecoder().decode(SignInOption.self, from: data)
        }
    }

    /// Calls `api.getSignInBoard`.
    public func getSignInBoard() async throws -> SignInBoard {
        let request = BlocksRequest(method: "api.getSignInBoard", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getSignInBoard") }
        return try client.makeDecoder().decode(SignInBoard.self, from: result)
    }

    /// Calls `api.getProviderDirectory`.
    public func getProviderDirectory() async throws -> ProviderDirectory {
        let request = BlocksRequest(method: "api.getProviderDirectory", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getProviderDirectory") }
        return try client.makeDecoder().decode(ProviderDirectory.self, from: result)
    }
}


// MARK: - Servers

public enum Servers {
    public static let local = BlocksServer(name: "local", url: "http://localhost:3001/aws-blocks/api")
}