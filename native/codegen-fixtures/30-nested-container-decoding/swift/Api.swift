import Foundation
import BlocksRuntime

public class Api {
    private let client: BlocksClient

    public init(server: BlocksServer = Servers.local) {
        self.client = BlocksClient(server: server)
    }

    /// Calls `api.getBoard`.
    public func getBoard() async throws -> Board {
        let request = BlocksRequest(method: "api.getBoard", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getBoard") }
        return try JSONDecoder().decode(Board.self, from: result)
    }

    /// Calls `api.saveLayout`.
    public func saveLayout(layout: Layout) async throws -> Layout {
        let request = BlocksRequest(method: "api.saveLayout", params: [layout], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.saveLayout") }
        return try JSONDecoder().decode(Layout.self, from: result)
    }

    /// Calls `api.groupNotes`.
    public func groupNotes(groups: [String: [Note]], levels: [Level]? = nil) async throws -> [String: [Note]] {
        var _params: [any Encodable] = [groups]
        if let levels { _params.append(levels) }
        let request = BlocksRequest(method: "api.groupNotes", params: _params, id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.groupNotes") }
        return try JSONDecoder().decode([String: [Note]].self, from: result)
    }

    /// Calls `api.listFeeds`.
    public func listFeeds() async throws -> [RealtimeChannel<Note>] {
        let request = BlocksRequest(method: "api.listFeeds", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.listFeeds") }
        return try JSONDecoder().decode([RealtimeChannel<Note>].self, from: result)
    }

    /// Calls `api.getLoginMenu`.
    public func getLoginMenu() async throws -> LoginMenu {
        let request = BlocksRequest(method: "api.getLoginMenu", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getLoginMenu") }
        return try client.makeDecoder().decode(LoginMenu.self, from: result)
    }
}


// MARK: - Servers

public enum Servers {
    public static let local = BlocksServer(name: "local", url: "http://localhost:3001/aws-blocks/api")
}