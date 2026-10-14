import Foundation
import BlocksRuntime

public final class Api: Sendable {
    private let client: BlocksClient

    public init(client: BlocksClient) {
        self.client = client
    }

    @available(*, deprecated, message: "Use blocks.api from one Blocks() or Blocks(server:) you hold")
    public convenience init(server: BlocksServer = Servers.local) {
        self.init(client: BlocksClient(server: server))
    }

    /// Calls `api.getClass`.
    public func getClass(id: String) async throws -> GetClass.Result {
        let request = BlocksRequest(method: "api.getClass", params: [id], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getClass") }
        return try JSONDecoder().decode(GetClass.Result.self, from: result)
    }

    /// Calls `api.import`.
    public func `import`(input: Import.Input) async throws -> Import.Result {
        let request = BlocksRequest(method: "api.import", params: [input], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.import") }
        return try JSONDecoder().decode(Import.Result.self, from: result)
    }

    /// Calls `api.export`.
    public func export() async throws -> Export.Result {
        let request = BlocksRequest(method: "api.export", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.export") }
        return try JSONDecoder().decode(Export.Result.self, from: result)
    }

    public enum GetClass {

        public struct Result: Codable {
            public let `class`: String
            public let `default`: String
            public let `in`: String
            public let `is`: Bool
            public let `return`: Int
            public let `self`: String
            public let `super`: String
            public let `switch`: String
            public let `type`: String
            public let val: String
            public let `var`: String
            public let when: String

            enum CodingKeys: String, CodingKey {
                case `class` = "class"
                case `default` = "default"
                case `in` = "in"
                case `is` = "is"
                case `return` = "return"
                case `self` = "self"
                case `super` = "super"
                case `switch` = "switch"
                case `type` = "type"
                case val
                case `var` = "var"
                case when
            }
        }
    }

    public enum Import {

        public struct Input: Codable {
            public let abstract: Bool
            public let `do`: Bool
            public let `else`: String
            public let `enum`: String
            public let extends: String
            public let final: String
            public let `for`: String
            public let `while`: Int

            enum CodingKeys: String, CodingKey {
                case abstract
                case `do` = "do"
                case `else` = "else"
                case `enum` = "enum"
                case extends
                case final
                case `for` = "for"
                case `while` = "while"
            }
        }

        public struct Result: Codable {
            public let ok: Bool
        }
    }

    public enum Export {

        public struct Result: Codable {
            public let `false`: Bool
            public let `internal`: String
            public let null: String
            public let object: String
            public let `operator`: String
            public let package: String
            public let this: String
            public let `throw`: String
            public let `true`: Bool

            enum CodingKeys: String, CodingKey {
                case `false` = "false"
                case `internal` = "internal"
                case null
                case object
                case `operator` = "operator"
                case package
                case this
                case `throw` = "throw"
                case `true` = "true"
            }
        }
    }
}


// MARK: - Blocks

/// One BlocksClient, so one URLSession (RPC and OIDC calls) and one token store, for every namespace in this spec;
/// file transfers and realtime use the shared runtime session. Hold one while the backend is in use: `let blocks = Blocks()`.
public final class Blocks: Sendable {
    /// The server every API calls.
    public let server: BlocksRuntime.BlocksServer
    /// The client every API runs on.
    public let client: BlocksRuntime.BlocksClient

    public let api: Api

    /// Defaults to the spec's first server; a `session` you pass stays yours.
    public init(
        server: BlocksRuntime.BlocksServer = Servers.local,
        session: URLSession? = nil,
        tokenStore: any BlocksRuntime.TokenStore = BlocksRuntime.InMemoryTokenStore()
    ) {
        self.server = server
        self.client = BlocksRuntime.BlocksClient(server: server, session: session, tokenStore: tokenStore)
        self.api = .init(client: client)
    }

    /// Later calls throw ClientClosedError; calls in flight finish, then the session this instance created is released.
    public func close() {
        client.close()
    }
}

// MARK: - Servers

public enum Servers {
    public static let local = BlocksServer(name: "local", url: "http://localhost:3001/aws-blocks/api")
}