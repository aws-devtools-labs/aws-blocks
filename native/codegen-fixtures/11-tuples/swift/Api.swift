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

    /// Calls `api.getCoords`.
    public func getCoords() async throws -> GetCoords.Result {
        let request = BlocksRequest(method: "api.getCoords", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getCoords") }
        return try JSONDecoder().decode(GetCoords.Result.self, from: result)
    }

    /// Calls `api.getPair`.
    public func getPair() async throws -> GetPair.Result {
        let request = BlocksRequest(method: "api.getPair", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getPair") }
        return try JSONDecoder().decode(GetPair.Result.self, from: result)
    }

    /// Calls `api.queryRange`.
    public func queryRange(range: QueryRange.Range, cursor: QueryRange.Cursor? = nil) async throws -> QueryRange.Result {
        var _params: [any Encodable] = [range]
        if let cursor { _params.append(cursor) }
        let request = BlocksRequest(method: "api.queryRange", params: _params, id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.queryRange") }
        return try JSONDecoder().decode(QueryRange.Result.self, from: result)
    }

    /// Calls `api.getShortTuples`.
    public func getShortTuples(one: [String]) async throws -> GetShortTuples.Result {
        let request = BlocksRequest(method: "api.getShortTuples", params: [one], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getShortTuples") }
        return try JSONDecoder().decode(GetShortTuples.Result.self, from: result)
    }

    public enum GetCoords {

        public struct Result: Codable {
            public let item0: Double
            public let item1: Double
            public let item2: String

            public init(from decoder: Decoder) throws {
                var c = try decoder.unkeyedContainer()
                self.item0 = try c.decode(Double.self)
                self.item1 = try c.decode(Double.self)
                self.item2 = try c.decode(String.self)
            }

            public func encode(to encoder: Encoder) throws {
                var c = encoder.unkeyedContainer()
                try c.encode(self.item0)
                try c.encode(self.item1)
                try c.encode(self.item2)
            }

            public init(item0: Double, item1: Double, item2: String) {
                self.item0 = item0
                self.item1 = item1
                self.item2 = item2
            }
        }
    }

    public enum GetPair {

        public struct Result: Codable {
            public let item0: String
            public let item1: Int

            public init(from decoder: Decoder) throws {
                var c = try decoder.unkeyedContainer()
                self.item0 = try c.decode(String.self)
                self.item1 = try c.decode(Int.self)
            }

            public func encode(to encoder: Encoder) throws {
                var c = encoder.unkeyedContainer()
                try c.encode(self.item0)
                try c.encode(self.item1)
            }

            public init(item0: String, item1: Int) {
                self.item0 = item0
                self.item1 = item1
            }
        }
    }

    public enum QueryRange {

        public struct Range: Codable {
            public let item0: Double
            public let item1: Double

            public init(from decoder: Decoder) throws {
                var c = try decoder.unkeyedContainer()
                self.item0 = try c.decode(Double.self)
                self.item1 = try c.decode(Double.self)
            }

            public func encode(to encoder: Encoder) throws {
                var c = encoder.unkeyedContainer()
                try c.encode(self.item0)
                try c.encode(self.item1)
            }

            public init(item0: Double, item1: Double) {
                self.item0 = item0
                self.item1 = item1
            }
        }

        public struct Cursor: Codable {
            public let item0: String
            public let item1: Int?

            public init(from decoder: Decoder) throws {
                var c = try decoder.unkeyedContainer()
                self.item0 = try c.decode(String.self)
                self.item1 = try c.decodeIfPresent(Int.self)
            }

            public func encode(to encoder: Encoder) throws {
                var c = encoder.unkeyedContainer()
                try c.encode(self.item0)
                try c.encode(self.item1)
            }

            public init(item0: String, item1: Int? = nil) {
                self.item0 = item0
                self.item1 = item1
            }
        }

        public struct Result: Codable {
            public let pairs: [Pair]
            public let `where`: Where

            enum CodingKeys: String, CodingKey {
                case pairs
                case `where` = "where"
            }

            public init(pairs: [Pair], `where`: Where) {
                self.pairs = pairs
                self.`where` = `where`
            }

            public struct Pair: Codable {
                public let item0: String
                public let item1: Int

                public init(from decoder: Decoder) throws {
                    var c = try decoder.unkeyedContainer()
                    self.item0 = try c.decode(String.self)
                    self.item1 = try c.decode(Int.self)
                }

                public func encode(to encoder: Encoder) throws {
                    var c = encoder.unkeyedContainer()
                    try c.encode(self.item0)
                    try c.encode(self.item1)
                }

                public init(item0: String, item1: Int) {
                    self.item0 = item0
                    self.item1 = item1
                }
            }

            public struct Where: Codable {
                public let between: Between

                public init(between: Between) {
                    self.between = between
                }

                public struct Between: Codable {
                    public let item0: String
                    public let item1: String

                    public init(from decoder: Decoder) throws {
                        var c = try decoder.unkeyedContainer()
                        self.item0 = try c.decode(String.self)
                        self.item1 = try c.decode(String.self)
                    }

                    public func encode(to encoder: Encoder) throws {
                        var c = encoder.unkeyedContainer()
                        try c.encode(self.item0)
                        try c.encode(self.item1)
                    }

                    public init(item0: String, item1: String) {
                        self.item0 = item0
                        self.item1 = item1
                    }
                }
            }
        }
    }

    public enum GetShortTuples {

        public struct Result: Codable {
            public let one: [Double]
            public let short: Short

            public init(one: [Double], short: Short) {
                self.one = one
                self.short = short
            }

            public struct Short: Codable {
                public let item0: String
                public let item1: Int?

                public init(from decoder: Decoder) throws {
                    var c = try decoder.unkeyedContainer()
                    self.item0 = try c.decode(String.self)
                    self.item1 = try c.decodeIfPresent(Int.self)
                }

                public func encode(to encoder: Encoder) throws {
                    var c = encoder.unkeyedContainer()
                    try c.encode(self.item0)
                    try c.encode(self.item1)
                }

                public init(item0: String, item1: Int? = nil) {
                    self.item0 = item0
                    self.item1 = item1
                }
            }
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