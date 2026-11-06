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

    /// Calls `api.updateAttributes`.
    public func updateAttributes(attributes: [String: String]) async throws -> [String: UpdateAttributes.ResultValue?] {
        let request = BlocksRequest(method: "api.updateAttributes", params: [attributes], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.updateAttributes") }
        return try JSONDecoder().decode([String: UpdateAttributes.ResultValue?].self, from: result)
    }

    /// Calls `api.getNotification`.
    public func getNotification(id: String) async throws -> GetNotification.Result? {
        let request = BlocksRequest(method: "api.getNotification", params: [id], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { return nil }
        return try JSONDecoder().decode(GetNotification.Result.self, from: result)
    }

    public enum UpdateAttributes {

        public struct IsUpdatedFalse: Codable {
            public let nextStep: NextStep

            public init(nextStep: NextStep) {
                self.nextStep = nextStep
            }

            public struct NextStep: Codable {
                public let destination: String
                public let name: String

                public init(destination: String, name: String) {
                    self.destination = destination
                    self.name = name
                }
            }
        }

        public enum ResultValue: Codable {
            case isUpdatedTrue
            case isUpdatedFalse(IsUpdatedFalse)

            enum CodingKeys: String, CodingKey {
                case isUpdated
            }

            public func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                switch self {
                case .isUpdatedTrue:
                    try container.encode(true, forKey: .isUpdated)
                case .isUpdatedFalse(let params):
                    try container.encode(false, forKey: .isUpdated)
                    try params.encode(to: encoder)
                }
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                let disc = try container.decode(Bool.self, forKey: .isUpdated)
                switch disc {
                case true: self = .isUpdatedTrue
                case false: self = .isUpdatedFalse(try IsUpdatedFalse(from: decoder))
                }
            }
        }
    }

    public enum GetNotification {

        public struct Email: Codable {
            public let body: String
            public let subject: String

            public init(body: String, subject: String) {
                self.body = body
                self.subject = subject
            }
        }

        public struct Sms: Codable {
            public let message: String

            public init(message: String) {
                self.message = message
            }
        }

        public enum Result: Codable {
            case email(Email)
            case sms(Sms)

            enum CodingKeys: String, CodingKey {
                case `type`
            }

            public func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                switch self {
                case .email(let params):
                    try container.encode("email", forKey: .`type`)
                    try params.encode(to: encoder)
                case .sms(let params):
                    try container.encode("sms", forKey: .`type`)
                    try params.encode(to: encoder)
                }
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                let disc = try container.decode(String.self, forKey: .`type`)
                switch disc {
                case "email": self = .email(try Email(from: decoder))
                case "sms": self = .sms(try Sms(from: decoder))
                default:
                    throw DecodingError.dataCorruptedError(forKey: .`type`, in: container, debugDescription: "Unknown value: \(disc)")
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