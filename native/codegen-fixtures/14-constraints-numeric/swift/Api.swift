import Foundation
import BlocksRuntime

public final nonisolated class Api: Sendable {
    private let client: BlocksClient

    public init(client: BlocksClient) {
        self.client = client
    }

    @available(*, deprecated, message: "Use blocks.api from one Blocks() or Blocks(server:) you hold")
    public convenience init(server: BlocksServer = Servers.local) {
        self.init(client: BlocksClient(server: server))
    }

    /// Calls `api.setScore`.
    public func setScore(input: SetScore.Input) async throws -> SetScore.Result {
        let request = BlocksRequest(method: "api.setScore", params: [input], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.setScore") }
        return try JSONDecoder().decode(SetScore.Result.self, from: result)
    }

    public enum SetScore {

        public struct Input: Codable {
            public let level: Int
            public let score: Double
            public let step: Double

            public init(level: Int, score: Double, step: Double) throws {
                self.level = level
                guard score >= 0.0 else { throw CodegenError.validation("score must be >= 0.0") }
                guard score <= 100.0 else { throw CodegenError.validation("score must be <= 100.0") }
                self.score = score
                guard step.truncatingRemainder(dividingBy: 0.5) == 0 else { throw CodegenError.validation("step must be a multiple of 0.5") }
                self.step = step
            }
        }

        public struct Result: Codable {
            public let ok: Bool
        }
    }
}


// MARK: - Blocks

/// One BlocksClient, so one URLSession (RPC and OIDC calls) and one token store, for every namespace in this spec;
/// file transfers and realtime use the shared runtime session. Hold one while the backend is in use: `let blocks = Blocks()`.
public final nonisolated class Blocks: Sendable {
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

public nonisolated enum Servers {
    public static let local = BlocksServer(name: "local", url: "http://localhost:3001/aws-blocks/api")
}