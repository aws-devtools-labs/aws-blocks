import Foundation
import BlocksRuntime

public class Api {
    private let client: BlocksClient

    public init(server: BlocksServer = Servers.local) {
        self.client = BlocksClient(server: server)
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

            public init(`class`: String, `default`: String, `in`: String, `is`: Bool, `return`: Int, `self` self_: String, `super`: String, `switch`: String, `type`: String, val: String, `var`: String, when: String) {
                self.`class` = `class`
                self.`default` = `default`
                self.`in` = `in`
                self.`is` = `is`
                self.`return` = `return`
                self.`self` = self_
                self.`super` = `super`
                self.`switch` = `switch`
                self.`type` = `type`
                self.val = val
                self.`var` = `var`
                self.when = when
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

            public init(abstract: Bool, `do`: Bool, `else`: String, `enum`: String, extends: String, final: String, `for`: String, `while`: Int) {
                self.abstract = abstract
                self.`do` = `do`
                self.`else` = `else`
                self.`enum` = `enum`
                self.extends = extends
                self.final = final
                self.`for` = `for`
                self.`while` = `while`
            }
        }

        public struct Result: Codable {
            public let ok: Bool

            public init(ok: Bool) {
                self.ok = ok
            }
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

            public init(`false`: Bool, `internal`: String, null: String, object: String, `operator`: String, package: String, this: String, `throw`: String, `true`: Bool) {
                self.`false` = `false`
                self.`internal` = `internal`
                self.null = null
                self.object = object
                self.`operator` = `operator`
                self.package = package
                self.this = this
                self.`throw` = `throw`
                self.`true` = `true`
            }
        }
    }
}


// MARK: - Servers

public enum Servers {
    public static let local = BlocksServer(name: "local", url: "http://localhost:3001/aws-blocks/api")
}