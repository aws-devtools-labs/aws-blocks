import Foundation
import BlocksRuntime

public class Api {
    private let client: BlocksClient

    public init(server: BlocksServer = Servers.local) {
        self.client = BlocksClient(server: server)
    }

    /// Calls `api.getDoc`.
    public func getDoc(_id: String, int: Int? = nil) async throws -> Doc {
        var _params: [any Encodable] = [_id]
        if let int { _params.append(int) }
        let request = BlocksRequest(method: "api.getDoc", params: _params, id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getDoc") }
        return try JSONDecoder().decode(Doc.self, from: result)
    }

    /// Calls `api.putExtras`.
    public func putExtras(extras: Extras) async throws -> Extras {
        let request = BlocksRequest(method: "api.putExtras", params: [extras], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.putExtras") }
        return try JSONDecoder().decode(Extras.self, from: result)
    }

    /// Calls `api.getLevel`.
    public func getLevel() async throws -> Level {
        let request = BlocksRequest(method: "api.getLevel", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getLevel") }
        return try JSONDecoder().decode(Level.self, from: result)
    }
}


// MARK: - Servers

public enum Servers {
    public static let local = BlocksServer(name: "local", url: "http://localhost:3001/aws-blocks/api")
}