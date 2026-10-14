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

    /// Calls `api.getOrganization`.
    public func getOrganization(id: String) async throws -> GetOrganization.Result {
        let request = BlocksRequest(method: "api.getOrganization", params: [id], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getOrganization") }
        return try JSONDecoder().decode(GetOrganization.Result.self, from: result)
    }

    /// Calls `api.createOrganization`.
    public func createOrganization(input: CreateOrganization.Input) async throws -> CreateOrganization.Result {
        let request = BlocksRequest(method: "api.createOrganization", params: [input], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.createOrganization") }
        return try JSONDecoder().decode(CreateOrganization.Result.self, from: result)
    }

    /// Calls `api.updateOrganization`.
    public func updateOrganization(input: UpdateOrganization.Input) async throws -> UpdateOrganization.Result {
        let request = BlocksRequest(method: "api.updateOrganization", params: [input], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.updateOrganization") }
        return try JSONDecoder().decode(UpdateOrganization.Result.self, from: result)
    }

    public enum GetOrganization {

        public struct Result: Codable {
            public let address: Address
            public let id: String
            public let name: String
            public let owner: Owner

            public struct Address: Codable {
                public let city: String
                public let contact: Contact
                public let street: String

                public struct Contact: Codable {
                    public let email: String
                }
            }

            public struct Owner: Codable {
                public let contact: Contact
                public let name: String

                public struct Contact: Codable {
                    public let email: String
                    public let phone: String
                }
            }
        }
    }

    public enum CreateOrganization {

        public struct Input: Codable {
            public let address: Address
            public let name: String
            public let owner: Owner

            public struct Address: Codable {
                public let city: String
                public let countryCode: String
                public let street: String
            }

            public struct Owner: Codable {
                public let email: String
                public let name: String
            }
        }

        public struct Result: Codable {
            public let id: String
        }
    }

    public enum UpdateOrganization {

        public struct Input: Codable {
            public let address: Address?
            public let id: String
            public let name: String?
            public let owner: Owner?

            enum CodingKeys: String, CodingKey {
                case address
                case id
                case name
                case owner
            }

            public func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                try c.encodeIfPresent(self.address, forKey: .address)
                try c.encode(self.id, forKey: .id)
                try c.encodeIfPresent(self.name, forKey: .name)
                try c.encodeIfPresent(self.owner, forKey: .owner)
            }

            public struct Address: Codable {
                public let city: String
                public let street: String
                public let zip: String
            }

            public struct Owner: Codable {
                public let contact: Contact
                public let name: String

                public struct Contact: Codable {
                    public let email: String
                    public let phone: String
                }
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