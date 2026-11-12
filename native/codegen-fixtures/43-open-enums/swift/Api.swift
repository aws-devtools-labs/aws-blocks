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

    /// Calls `api.getTask`.
    public func getTask(id: String) async throws -> Task {
        let request = BlocksRequest(method: "api.getTask", params: [id], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getTask") }
        return try JSONDecoder().decode(Task.self, from: result)
    }

    /// Calls `api.updateTask`.
    public func updateTask(id: String, status: Status, sort: UpdateTask.Sort? = nil) async throws -> UpdateTask.Result {
        var _params: [any Encodable] = [id, status]
        if let sort { _params.append(sort) }
        let request = BlocksRequest(method: "api.updateTask", params: _params, id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.updateTask") }
        return try JSONDecoder().decode(UpdateTask.Result.self, from: result)
    }

    /// Calls `api.getEvent`.
    public func getEvent() async throws -> GetEvent.Result {
        let request = BlocksRequest(method: "api.getEvent", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getEvent") }
        return try JSONDecoder().decode(GetEvent.Result.self, from: result)
    }

    /// Calls `api.watchTasks`.
    public func watchTasks() async throws -> RealtimeChannel<WatchTasks.ResultMessage> {
        let request = BlocksRequest(method: "api.watchTasks", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.watchTasks") }
        return try self.client.makeDecoder().decode(RealtimeChannel<WatchTasks.ResultMessage>.self, from: result)
    }

    public enum UpdateTask {

        public enum Sort: String, Codable {
            case newest
            case oldest
        }

        public struct Result: Codable {
            public let ok: Bool

            public init(ok: Bool) {
                self.ok = ok
            }
        }
    }

    public enum GetEvent {

        public struct Moved: Codable {
            public let to: Status

            public init(to: Status) {
                self.to = to
            }
        }

        public struct Flagged: Codable {
            public let severity: Severity

            public init(severity: Severity) {
                self.severity = severity
            }

            public enum Severity: RawRepresentable, Codable, Hashable {
                case low
                case high
                /// A value this client was generated without, as the server sent it.
                case unknown(String)

                public init(rawValue: String) {
                    switch rawValue {
                    case "low": self = .low
                    case "high": self = .high
                    default: self = .unknown(rawValue)
                    }
                }

                public var rawValue: String {
                    switch self {
                    case .low: return "low"
                    case .high: return "high"
                    case .unknown(let value): return value
                    }
                }
            }
        }

        public enum Result: Codable {
            case moved(Moved)
            case flagged(Flagged)

            enum CodingKeys: String, CodingKey {
                case kind
            }

            public func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                switch self {
                case .moved(let params):
                    try container.encode("moved", forKey: .kind)
                    try params.encode(to: encoder)
                case .flagged(let params):
                    try container.encode("flagged", forKey: .kind)
                    try params.encode(to: encoder)
                }
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                let disc = try container.decode(String.self, forKey: .kind)
                switch disc {
                case "moved": self = .moved(try Moved(from: decoder))
                case "flagged": self = .flagged(try Flagged(from: decoder))
                default:
                    throw DecodingError.dataCorruptedError(forKey: .kind, in: container, debugDescription: "Unknown value: \(disc)")
                }
            }
        }
    }

    public enum WatchTasks {

        public struct ResultMessage: Codable {
            public let change: Change
            public let taskId: String

            public init(change: Change, taskId: String) {
                self.change = change
                self.taskId = taskId
            }

            public enum Change: RawRepresentable, Codable, Hashable {
                case created
                case deleted
                /// A value this client was generated without, as the server sent it.
                case unknown(String)

                public init(rawValue: String) {
                    switch rawValue {
                    case "created": self = .created
                    case "deleted": self = .deleted
                    default: self = .unknown(rawValue)
                    }
                }

                public var rawValue: String {
                    switch self {
                    case .created: return "created"
                    case .deleted: return "deleted"
                    case .unknown(let value): return value
                    }
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