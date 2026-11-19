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
        guard let result else { throw TransportError(message: "Unexpected null result for api.getTask") }
        return try JSONDecoder().decode(Task.self, from: result)
    }

    /// Calls `api.updateTask`.
    public func updateTask(id: String, status: Status, sort: UpdateTask.Sort? = nil) async throws -> UpdateTask.Result {
        var _params: [any Encodable] = [id, status]
        if let sort { _params.append(sort) }
        let request = BlocksRequest(method: "api.updateTask", params: _params, id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw TransportError(message: "Unexpected null result for api.updateTask") }
        return try JSONDecoder().decode(UpdateTask.Result.self, from: result)
    }

    /// Calls `api.getEvent`.
    public func getEvent() async throws -> GetEvent.Result {
        let request = BlocksRequest(method: "api.getEvent", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw TransportError(message: "Unexpected null result for api.getEvent") }
        return try JSONDecoder().decode(GetEvent.Result.self, from: result)
    }

    /// Calls `api.watchTasks`.
    public func watchTasks() async throws -> RealtimeChannel<WatchTasks.ResultMessage> {
        let request = BlocksRequest(method: "api.watchTasks", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw TransportError(message: "Unexpected null result for api.watchTasks") }
        return try self.client.makeDecoder().decode(RealtimeChannel<WatchTasks.ResultMessage>.self, from: result)
    }

    /// Calls `api.getColor`.
    public func getColor() async throws -> Color {
        let request = BlocksRequest(method: "api.getColor", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw TransportError(message: "Unexpected null result for api.getColor") }
        return try JSONDecoder().decode(Color.self, from: result)
    }

    /// Calls `api.getSwatch`.
    public func getSwatch() async throws -> GetSwatch.Result {
        let request = BlocksRequest(method: "api.getSwatch", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw TransportError(message: "Unexpected null result for api.getSwatch") }
        return try JSONDecoder().decode(GetSwatch.Result.self, from: result)
    }

    /// Calls `api.setMode`.
    public func setMode(mode: Mode) async throws -> Bool {
        let request = BlocksRequest(method: "api.setMode", params: [mode], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw TransportError(message: "Unexpected null result for api.setMode") }
        return try JSONDecoder().decode(Bool.self, from: result)
    }

    /// Calls `api.getSettings`.
    public func getSettings() async throws -> GetSettings.Result {
        let request = BlocksRequest(method: "api.getSettings", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw TransportError(message: "Unexpected null result for api.getSettings") }
        return try JSONDecoder().decode(GetSettings.Result.self, from: result)
    }

    /// Calls `api.getTree`.
    public func getTree() async throws -> Node {
        let request = BlocksRequest(method: "api.getTree", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw TransportError(message: "Unexpected null result for api.getTree") }
        return try JSONDecoder().decode(Node.self, from: result)
    }

    /// Calls `api.getRange`.
    public func getRange() async throws -> GetRange.Result {
        let request = BlocksRequest(method: "api.getRange", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw TransportError(message: "Unexpected null result for api.getRange") }
        return try JSONDecoder().decode(GetRange.Result.self, from: result)
    }

    /// Calls `api.getLabels`.
    public func getLabels() async throws -> Labels {
        let request = BlocksRequest(method: "api.getLabels", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw TransportError(message: "Unexpected null result for api.getLabels") }
        return try JSONDecoder().decode(Labels.self, from: result)
    }

    /// Calls `api.getJob`.
    public func getJob() async throws -> GetJob.Result {
        let request = BlocksRequest(method: "api.getJob", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw TransportError(message: "Unexpected null result for api.getJob") }
        return try JSONDecoder().decode(GetJob.Result.self, from: result)
    }

    /// Calls `api.getAuthStep`.
    public func getAuthStep() async throws -> AuthStep {
        let request = BlocksRequest(method: "api.getAuthStep", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw TransportError(message: "Unexpected null result for api.getAuthStep") }
        return try JSONDecoder().decode(AuthStep.self, from: result)
    }

    /// Calls `api.getSignal`.
    public func getSignal() async throws -> GetSignal.Result {
        let request = BlocksRequest(method: "api.getSignal", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw TransportError(message: "Unexpected null result for api.getSignal") }
        return try JSONDecoder().decode(GetSignal.Result.self, from: result)
    }

    public enum UpdateTask {

        public enum Sort: String, Codable, Sendable {
            case newest
            case oldest
        }

        public struct Result: Codable, Sendable {
            public let ok: Bool

            public init(ok: Bool) {
                self.ok = ok
            }
        }
    }

    public enum GetEvent {

        public struct Moved: Codable, Sendable {
            public let to: Status

            public init(to: Status) {
                self.to = to
            }
        }

        public struct Flagged: Codable, Sendable {
            public let severity: Severity

            public init(severity: Severity) {
                self.severity = severity
            }

            public enum Severity: RawRepresentable, Codable, Hashable, Sendable {
                case low
                case high
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

                public static func == (lhs: Self, rhs: Self) -> Bool {
                    switch (lhs, rhs) {
                    case (.low, .low): return true
                    case (.high, .high): return true
                    case let (.unknown(lhs), .unknown(rhs)): return lhs == rhs
                    default: return false
                    }
                }

                public func hash(into hasher: inout Hasher) {
                    switch self {
                    case .low: hasher.combine(0)
                    case .high: hasher.combine(1)
                    case .unknown(let value):
                        hasher.combine(2)
                        hasher.combine(value)
                    }
                }
            }
        }

        public struct Unknown: Codable, Sendable {
            public let note: String

            public init(note: String) {
                self.note = note
            }
        }

        public enum Result: Codable, Sendable {
            case moved(Moved)
            case flagged(Flagged)
            case unknown(Unknown)
            case unknownValue(JSONValue)

            enum CodingKeys: String, CodingKey {
                case kind
            }

            public func encode(to encoder: Encoder) throws {
                switch self {
                case .moved(let params):
                    var container = encoder.container(keyedBy: CodingKeys.self)
                    try container.encode("moved", forKey: .kind)
                    try params.encode(to: encoder)
                case .flagged(let params):
                    var container = encoder.container(keyedBy: CodingKeys.self)
                    try container.encode("flagged", forKey: .kind)
                    try params.encode(to: encoder)
                case .unknown(let params):
                    var container = encoder.container(keyedBy: CodingKeys.self)
                    try container.encode("unknown", forKey: .kind)
                    try params.encode(to: encoder)
                case .unknownValue(let value):
                    try value.encode(to: encoder)
                }
            }

            public var unknownDiscriminator: String? {
                guard case .unknownValue(.dictionary(let object)) = self,
                      case .string(let tag)? = object["kind"] else { return nil }
                return tag
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                let disc = try container.decode(String.self, forKey: .kind)
                switch disc {
                case "moved": self = .moved(try Moved(from: decoder))
                case "flagged": self = .flagged(try Flagged(from: decoder))
                case "unknown": self = .unknown(try Unknown(from: decoder))
                default:
                    self = .unknownValue(try JSONValue(from: decoder))
                }
            }
        }
    }

    public enum WatchTasks {

        public struct ResultMessage: Codable, Sendable {
            public let change: Change
            public let taskId: String

            public init(change: Change, taskId: String) {
                self.change = change
                self.taskId = taskId
            }

            public enum Change: RawRepresentable, Codable, Hashable, Sendable {
                case created
                case deleted
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

                public static func == (lhs: Self, rhs: Self) -> Bool {
                    switch (lhs, rhs) {
                    case (.created, .created): return true
                    case (.deleted, .deleted): return true
                    case let (.unknown(lhs), .unknown(rhs)): return lhs == rhs
                    default: return false
                    }
                }

                public func hash(into hasher: inout Hasher) {
                    switch self {
                    case .created: hasher.combine(0)
                    case .deleted: hasher.combine(1)
                    case .unknown(let value):
                        hasher.combine(2)
                        hasher.combine(value)
                    }
                }
            }
        }
    }

    public enum GetSwatch {

        public enum Result: Codable, Sendable {
            case color(Color)
            case size(Size)

            public func encode(to encoder: Encoder) throws {
                switch self {
                case .color(let payload):
                    try payload.encode(to: encoder)
                case .size(let payload):
                    try payload.encode(to: encoder)
                }
            }

            public init(from decoder: Decoder) throws {
                if let value = try? Color(from: decoder), ["red", "blue"].contains(value.rawValue) {
                    self = .color(value)
                    return
                }
                if let value = try? Size(from: decoder), ["small", "large"].contains(value.rawValue) {
                    self = .size(value)
                    return
                }
                throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "No Result variant matched"))
            }

            private enum EmptyKey: CodingKey {}
        }
    }

    public enum GetSettings {

        public struct Result: Codable, Sendable {
            public let mode: Mode

            public init(mode: Mode) {
                self.mode = mode
            }

            public enum Mode: RawRepresentable, Codable, Hashable, Sendable {
                case light
                case dark
                case unknown(String)

                public init(rawValue: String) {
                    switch rawValue {
                    case "light": self = .light
                    case "dark": self = .dark
                    default: self = .unknown(rawValue)
                    }
                }

                public var rawValue: String {
                    switch self {
                    case .light: return "light"
                    case .dark: return "dark"
                    case .unknown(let value): return value
                    }
                }

                public static func == (lhs: Self, rhs: Self) -> Bool {
                    switch (lhs, rhs) {
                    case (.light, .light): return true
                    case (.dark, .dark): return true
                    case let (.unknown(lhs), .unknown(rhs)): return lhs == rhs
                    default: return false
                    }
                }

                public func hash(into hasher: inout Hasher) {
                    switch self {
                    case .light: hasher.combine(0)
                    case .dark: hasher.combine(1)
                    case .unknown(let value):
                        hasher.combine(2)
                        hasher.combine(value)
                    }
                }
            }
        }
    }

    public enum GetRange {

        public struct Result: Codable, Sendable {
            public let item0: Size
            public let item1: Item1

            public init(from decoder: Decoder) throws {
                var c = try decoder.unkeyedContainer()
                self.item0 = try c.decode(Size.self)
                self.item1 = try c.decode(Item1.self)
            }

            public func encode(to encoder: Encoder) throws {
                var c = encoder.unkeyedContainer()
                try c.encode(self.item0)
                try c.encode(self.item1)
            }

            public init(item0: Size, item1: Item1) {
                self.item0 = item0
                self.item1 = item1
            }

            public enum Item1: RawRepresentable, Codable, Hashable, Sendable {
                case up
                case down
                case unknown(String)

                public init(rawValue: String) {
                    switch rawValue {
                    case "up": self = .up
                    case "down": self = .down
                    default: self = .unknown(rawValue)
                    }
                }

                public var rawValue: String {
                    switch self {
                    case .up: return "up"
                    case .down: return "down"
                    case .unknown(let value): return value
                    }
                }

                public static func == (lhs: Self, rhs: Self) -> Bool {
                    switch (lhs, rhs) {
                    case (.up, .up): return true
                    case (.down, .down): return true
                    case let (.unknown(lhs), .unknown(rhs)): return lhs == rhs
                    default: return false
                    }
                }

                public func hash(into hasher: inout Hasher) {
                    switch self {
                    case .up: hasher.combine(0)
                    case .down: hasher.combine(1)
                    case .unknown(let value):
                        hasher.combine(2)
                        hasher.combine(value)
                    }
                }
            }
        }
    }

    public enum GetJob {

        public enum Result: Codable, Sendable {
            case pending(Pending)
            case failed(Failed)

            public func encode(to encoder: Encoder) throws {
                switch self {
                case .pending(let payload):
                    try payload.encode(to: encoder)
                case .failed(let payload):
                    try payload.encode(to: encoder)
                }
            }

            public init(from decoder: Decoder) throws {
                var lastError: Error?
                do {
                    self = .pending(try Pending(from: decoder))
                    return
                } catch { lastError = error }
                do {
                    self = .failed(try Failed(from: decoder))
                    return
                } catch { lastError = error }
                throw lastError ?? DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "No Result variant matched"))
            }

            private enum EmptyKey: CodingKey {}
        }
    }

    public enum GetSignal {

        public struct UnKnown: Codable, Sendable {
            public let note: String

            public init(note: String) {
                self.note = note
            }
        }

        public enum Result: Codable, Sendable {
            case unKnown(UnKnown)
            case on
            case unknown(JSONValue)

            enum CodingKeys: String, CodingKey {
                case kind
            }

            public func encode(to encoder: Encoder) throws {
                switch self {
                case .unKnown(let params):
                    var container = encoder.container(keyedBy: CodingKeys.self)
                    try container.encode("un-known", forKey: .kind)
                    try params.encode(to: encoder)
                case .on:
                    var container = encoder.container(keyedBy: CodingKeys.self)
                    try container.encode("on", forKey: .kind)
                case .unknown(let value):
                    try value.encode(to: encoder)
                }
            }

            public var unknownDiscriminator: String? {
                guard case .unknown(.dictionary(let object)) = self,
                      case .string(let tag)? = object["kind"] else { return nil }
                return tag
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                let disc = try container.decode(String.self, forKey: .kind)
                switch disc {
                case "un-known": self = .unKnown(try UnKnown(from: decoder))
                case "on": self = .on
                default:
                    self = .unknown(try JSONValue(from: decoder))
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
    public static let local = BlocksServer(name: "local", url: "http://localhost:3001/cdk-blocks/api")
}