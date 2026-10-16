import Foundation
import BlocksRuntime

public class Api {
    private let client: BlocksClient

    public init(server: BlocksServer = Servers.local) {
        self.client = BlocksClient(server: server)
    }

    /// Calls `api.echo`.
    public func echo(payload: JSONValue) async throws -> JSONValue {
        let request = BlocksRequest(method: "api.echo", params: [payload], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.echo") }
        return try JSONDecoder().decode(JSONValue.self, from: result)
    }

    /// Calls `api.store`.
    public func store(entry: Entry) async throws -> Entry {
        let request = BlocksRequest(method: "api.store", params: [entry], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.store") }
        return try JSONDecoder().decode(Entry.self, from: result)
    }

    /// Calls `api.collect`.
    public func collect(items: [JSONValue], metadata: [String: JSONValue], maybe: JSONValue?, holes: [JSONValue?], sparse: [String: JSONValue?], extra: JSONValue? = nil) async throws -> [JSONValue] {
        var _params: [any Encodable] = [items, metadata, maybe, holes, sparse]
        if let extra { _params.append(extra) }
        let request = BlocksRequest(method: "api.collect", params: _params, id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.collect") }
        return try JSONDecoder().decode([JSONValue].self, from: result)
    }
}


// MARK: - Servers

public enum Servers {
    public static let local = BlocksServer(name: "local", url: "http://localhost:3001/aws-blocks/api")
}