import Foundation
import BlocksRuntime

public class Api {
    private let client: BlocksClient

    public init(server: BlocksServer = Servers.local) {
        self.client = BlocksClient(server: server)
    }

    /// Calls `api.getScores`.
    public func getScores() async throws -> [String: Double] {
        let request = BlocksRequest(method: "api.getScores", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getScores") }
        return try JSONDecoder().decode([String: Double].self, from: result)
    }

    /// Calls `api.signUp`.
    public func signUp(input: SignUp.Input) async throws -> SignUp.Result {
        let request = BlocksRequest(method: "api.signUp", params: [input], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.signUp") }
        return try JSONDecoder().decode(SignUp.Result.self, from: result)
    }

    public enum SignUp {

        public struct Input: Codable {
            public let password: String
            public let username: String
            public let attributes: [String: String]

            public init(password: String, username: String, attributes: [String: String] = [:]) {
                self.password = password
                self.username = username
                self.attributes = attributes
            }

            private struct DynamicKey: CodingKey {
                var stringValue: String
                var intValue: Int? { nil }
                init?(stringValue: String) { self.stringValue = stringValue }
                init?(intValue: Int) { return nil }
            }

            private static let fixedFieldNames: Set<String> = [
                "password",
                "username",
            ]

            public func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: DynamicKey.self)
                try c.encode(self.password, forKey: DynamicKey(stringValue: "password")!)
                try c.encode(self.username, forKey: DynamicKey(stringValue: "username")!)
                for (k, v) in self.attributes where !Self.fixedFieldNames.contains(k) {
                    try c.encode(v, forKey: DynamicKey(stringValue: k)!)
                }
            }

            public init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: DynamicKey.self)
                self.password = try c.decode(String.self, forKey: DynamicKey(stringValue: "password")!)
                self.username = try c.decode(String.self, forKey: DynamicKey(stringValue: "username")!)
                var extras: [String: String] = [:]
                for key in c.allKeys where !Self.fixedFieldNames.contains(key.stringValue) {
                    extras[key.stringValue] = try c.decode(String.self, forKey: key)
                }
                self.attributes = extras
            }
        }

        public struct Result: Codable {
            public let ok: Bool

            public init(ok: Bool) {
                self.ok = ok
            }
        }
    }
}


// MARK: - Servers

public enum Servers {
    public static let local = BlocksServer(name: "local", url: "http://localhost:3001/aws-blocks/api")
}