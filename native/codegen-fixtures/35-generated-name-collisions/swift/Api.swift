import Foundation
import BlocksRuntime

public class A {
    private let client: BlocksClient

    public init(server: BlocksServer = Servers.local) {
        self.client = BlocksClient(server: server)
    }

    /// Calls `a.b.ping`.
    public func b_ping() async throws -> String {
        let request = BlocksRequest(method: "a.b.ping", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for a.b.ping") }
        return try JSONDecoder().decode(String.self, from: result)
    }
}

public class Api {
    private let client: BlocksClient

    public init(server: BlocksServer = Servers.local) {
        self.client = BlocksClient(server: server)
    }

    /// Calls `api.send`.
    public func send(request: String, `class`: String, args: String? = nil, json: String? = nil) async throws -> Send.Result {
        var _params: [any Encodable] = [request, `class`]
        if let args { _params.append(args) } else if json != nil { _params.append(JSONValue.null) }
        if let json { _params.append(json) }
        let request_2 = BlocksRequest(method: "api.send", params: _params, id: BlocksRequest.nextId())
        let result = try await client.execute(request_2)
        guard let result else { throw RPCError(message: "Unexpected null result for api.send") }
        return try JSONDecoder().decode(Send.Result.self, from: result)
    }

    /// Calls `api.getProfile`.
    public func getProfile(profile: Profile) async throws -> Profile {
        let request = BlocksRequest(method: "api.getProfile", params: [profile], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getProfile") }
        return try JSONDecoder().decode(Profile.self, from: result)
    }

    /// Calls `api.one`.
    public func one() async throws -> One.Result {
        let request = BlocksRequest(method: "api.one", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.one") }
        return try JSONDecoder().decode(One.Result.self, from: result)
    }

    /// Calls `api.two`.
    public func two() async throws -> Two.Result {
        let request = BlocksRequest(method: "api.two", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.two") }
        return try JSONDecoder().decode(Two.Result.self, from: result)
    }

    /// Calls `api.relay`.
    public func relay(client: String) async throws -> String {
        let request = BlocksRequest(method: "api.relay", params: [client], id: BlocksRequest.nextId())
        let result = try await self.client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.relay") }
        return try JSONDecoder().decode(String.self, from: result)
    }

    /// Calls `api.putBag`.
    public func putBag(bag: Bag) async throws -> Bag {
        let request = BlocksRequest(method: "api.putBag", params: [bag], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.putBag") }
        return try JSONDecoder().decode(Bag.self, from: result)
    }

    /// Calls `api.getWeird`.
    public func getWeird(weird: Weird) async throws -> Weird {
        let request = BlocksRequest(method: "api.getWeird", params: [weird], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getWeird") }
        return try JSONDecoder().decode(Weird.self, from: result)
    }

    public enum Send {

        public struct Result: Codable {
            public let sent: String

            public init(sent: String) {
                self.sent = sent
            }
        }
    }

    public enum One {

        public struct Result: Codable {
            public let a: String

            public init(a: String) {
                self.a = a
            }
        }
    }

    public enum Two {

        public struct Result: Codable {
            public let b: Double

            public init(b: Double) {
                self.b = b
            }
        }
    }
}


// MARK: - Servers

public enum Servers {
    public static let local = BlocksServer(name: "local", url: "http://localhost:3001/aws-blocks/api")
}