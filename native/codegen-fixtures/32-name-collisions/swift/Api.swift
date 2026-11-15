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

    /// Calls `api.getCart`.
    public func getCart() async throws -> Cart {
        let request = BlocksRequest(method: "api.getCart", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getCart") }
        return try JSONDecoder().decode(Cart.self, from: result)
    }

    /// Calls `api.getOrder`.
    public func getOrder() async throws -> Order {
        let request = BlocksRequest(method: "api.getOrder", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getOrder") }
        return try JSONDecoder().decode(Order.self, from: result)
    }

    /// Calls `api.getTicket`.
    public func getTicket() async throws -> Ticket {
        let request = BlocksRequest(method: "api.getTicket", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getTicket") }
        return try JSONDecoder().decode(Ticket.self, from: result)
    }

    /// Calls `api.getKind`.
    public func getKind() async throws -> Kind {
        let request = BlocksRequest(method: "api.getKind", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getKind") }
        return try JSONDecoder().decode(Kind.self, from: result)
    }

    /// Calls `api.putItems`.
    public func putItems(item: PutItems.Item, items: [PutItems.Items]) async throws -> PutItems.Result {
        let request = BlocksRequest(method: "api.putItems", params: [item, items], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.putItems") }
        return try JSONDecoder().decode(PutItems.Result.self, from: result)
    }

    /// Calls `api.getFeeds`.
    public func getFeeds() async throws -> GetFeeds.Result {
        let request = BlocksRequest(method: "api.getFeeds", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getFeeds") }
        return try JSONDecoder().decode(GetFeeds.Result.self, from: result)
    }

    /// Calls `api.act`.
    public func act() async throws -> Act.Result {
        let request = BlocksRequest(method: "api.act", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.act") }
        return try JSONDecoder().decode(Act.Result.self, from: result)
    }

    /// Calls `api.check`.
    public func check(result: Check.Result_2) async throws -> Check.Result {
        let request = BlocksRequest(method: "api.check", params: [result], id: BlocksRequest.nextId())
        let result_2 = try await client.execute(request)
        guard let result_2 else { throw RPCError(message: "Unexpected null result for api.check") }
        return try JSONDecoder().decode(Check.Result.self, from: result_2)
    }

    public enum PutItems {

        public struct Item: Codable {
            public let sku: String

            public init(sku: String) {
                self.sku = sku
            }
        }

        public struct Items: Codable {
            public let qty: Double
            public let sku: String

            public init(qty: Double, sku: String) {
                self.qty = qty
                self.sku = sku
            }
        }

        public struct Result: Codable {
            public let item: Item
            public let items: [Items]

            public init(item: Item, items: [Items]) {
                self.item = item
                self.items = items
            }

            public struct Item: Codable {
                public let count: Double

                public init(count: Double) {
                    self.count = count
                }
            }

            public struct Items: Codable {
                public let sku: String

                public init(sku: String) {
                    self.sku = sku
                }
            }
        }
    }

    public enum GetFeeds {

        public struct Result: Codable {
            public let feed: RealtimeChannel<FeedMessage>
            public let feeds: [RealtimeChannel<FeedsMessage>]

            public init(feed: RealtimeChannel<FeedMessage>, feeds: [RealtimeChannel<FeedsMessage>]) {
                self.feed = feed
                self.feeds = feeds
            }

            public struct FeedMessage: Codable {
                public let text: String

                public init(text: String) {
                    self.text = text
                }
            }

            public struct FeedsMessage: Codable {
                public let count: Double

                public init(count: Double) {
                    self.count = count
                }
            }
        }
    }

    public enum Act {

        public struct Pick: Codable {
            public let item: Item
            public let items: [Items]

            public init(item: Item, items: [Items]) {
                self.item = item
                self.items = items
            }

            public struct Item: Codable {
                public let sku: String

                public init(sku: String) {
                    self.sku = sku
                }
            }

            public struct Items: Codable {
                public let qty: Double

                public init(qty: Double) {
                    self.qty = qty
                }
            }
        }

        public struct Skip: Codable {
            public let reason: String

            public init(reason: String) {
                self.reason = reason
            }
        }

        public enum Result: Codable {
            case pick(Pick)
            case skip(Skip)

            enum CodingKeys: String, CodingKey {
                case action
            }

            public func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                switch self {
                case .pick(let params):
                    try container.encode("pick", forKey: .action)
                    try params.encode(to: encoder)
                case .skip(let params):
                    try container.encode("skip", forKey: .action)
                    try params.encode(to: encoder)
                }
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                let disc = try container.decode(String.self, forKey: .action)
                switch disc {
                case "pick": self = .pick(try Pick(from: decoder))
                case "skip": self = .skip(try Skip(from: decoder))
                default:
                    throw DecodingError.dataCorruptedError(forKey: .action, in: container, debugDescription: "Unknown value: \(disc)")
                }
            }
        }
    }

    public enum Check {

        public struct Result_2: Codable {
            public let input: String

            public init(input: String) {
                self.input = input
            }
        }

        public struct Result: Codable {
            public let passed: Bool

            public init(passed: Bool) {
                self.passed = passed
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