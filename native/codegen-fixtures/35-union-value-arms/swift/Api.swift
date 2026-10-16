import Foundation
import BlocksRuntime

public class Api {
    private let client: BlocksClient

    public init(server: BlocksServer = Servers.local) {
        self.client = BlocksClient(server: server)
    }

    /// Calls `api.echoPrimitive`.
    public func echoPrimitive(value: EchoPrimitive.Value?) async throws -> EchoPrimitive.Value? {
        let request = BlocksRequest(method: "api.echoPrimitive", params: [value], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { return nil }
        return try JSONDecoder().decode(EchoPrimitive.Value.self, from: result)
    }

    /// Calls `api.echoCollection`.
    public func echoCollection(value: EchoCollection.Value) async throws -> EchoCollection.Value {
        let request = BlocksRequest(method: "api.echoCollection", params: [value], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.echoCollection") }
        return try JSONDecoder().decode(EchoCollection.Value.self, from: result)
    }

    /// Calls `api.echoShape`.
    public func echoShape(value: EchoShape.Value) async throws -> EchoShape.Value {
        let request = BlocksRequest(method: "api.echoShape", params: [value], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.echoShape") }
        return try JSONDecoder().decode(EchoShape.Value.self, from: result)
    }

    /// Calls `api.echoLiteral`.
    public func echoLiteral(value: EchoLiteral.Value) async throws -> EchoLiteral.Result {
        let request = BlocksRequest(method: "api.echoLiteral", params: [value], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.echoLiteral") }
        return try JSONDecoder().decode(EchoLiteral.Result.self, from: result)
    }

    /// Calls `api.echoTagged`.
    public func echoTagged(value: EchoTagged.Value) async throws -> EchoTagged.Value {
        let request = BlocksRequest(method: "api.echoTagged", params: [value], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.echoTagged") }
        return try JSONDecoder().decode(EchoTagged.Value.self, from: result)
    }

    /// Calls `api.echoMoment`.
    public func echoMoment(value: EchoMoment.Value) async throws -> EchoMoment.Value {
        let request = BlocksRequest(method: "api.echoMoment", params: [value], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.echoMoment") }
        return try client.makeDecoder().decode(EchoMoment.Value.self, from: result)
    }

    /// Calls `api.getFile`.
    public func getFile() async throws -> GetFile.Result {
        let request = BlocksRequest(method: "api.getFile", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getFile") }
        return try JSONDecoder().decode(GetFile.Result.self, from: result)
    }

    public enum EchoPrimitive {

        public enum Value: Codable {
            case value_Variant0(String)
            case value_Variant1(Int)
            case value_Variant2(Double)
            case value_Variant3(Bool)

            public func encode(to encoder: Encoder) throws {
                switch self {
                case .value_Variant0(let payload):
                    var container = encoder.singleValueContainer()
                    try container.encode(payload)
                case .value_Variant1(let payload):
                    var container = encoder.singleValueContainer()
                    try container.encode(payload)
                case .value_Variant2(let payload):
                    var container = encoder.singleValueContainer()
                    try container.encode(payload)
                case .value_Variant3(let payload):
                    var container = encoder.singleValueContainer()
                    try container.encode(payload)
                }
            }

            public init(from decoder: Decoder) throws {
                var lastError: Error?
                do {
                    self = .value_Variant0(try decoder.singleValueContainer().decode(String.self))
                    return
                } catch { lastError = error }
                do {
                    self = .value_Variant1(try decoder.singleValueContainer().decode(Int.self))
                    return
                } catch { lastError = error }
                do {
                    self = .value_Variant2(try decoder.singleValueContainer().decode(Double.self))
                    return
                } catch { lastError = error }
                do {
                    self = .value_Variant3(try decoder.singleValueContainer().decode(Bool.self))
                    return
                } catch { lastError = error }
                throw lastError ?? DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "No Value variant matched"))
            }

            private enum EmptyKey: CodingKey {}
        }
    }

    public enum EchoCollection {

        public enum Value: Codable {
            case value_Variant0([String])
            case value_Variant1([String: Int])

            public func encode(to encoder: Encoder) throws {
                switch self {
                case .value_Variant0(let payload):
                    var container = encoder.singleValueContainer()
                    try container.encode(payload)
                case .value_Variant1(let payload):
                    var container = encoder.singleValueContainer()
                    try container.encode(payload)
                }
            }

            public init(from decoder: Decoder) throws {
                var lastError: Error?
                do {
                    self = .value_Variant0(try decoder.singleValueContainer().decode([String].self))
                    return
                } catch { lastError = error }
                do {
                    self = .value_Variant1(try decoder.singleValueContainer().decode([String: Int].self))
                    return
                } catch { lastError = error }
                throw lastError ?? DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "No Value variant matched"))
            }

            private enum EmptyKey: CodingKey {}
        }
    }

    public enum EchoShape {

        public struct Value_Variant1: Codable {
            public let label: String
            public let tags: [String]?

            enum CodingKeys: String, CodingKey {
                case label
                case tags
            }

            public func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                try c.encode(self.label, forKey: .label)
                try c.encodeIfPresent(self.tags, forKey: .tags)
            }

            public init(label: String, tags: [String]? = nil) {
                self.label = label
                self.tags = tags
            }
        }

        public enum Value: Codable {
            case point(Point)
            case value_Variant1(Value_Variant1)
            case value_Variant2([Point])
            case value_Variant3([String: String])

            public func encode(to encoder: Encoder) throws {
                switch self {
                case .point(let payload):
                    try payload.encode(to: encoder)
                case .value_Variant1(let payload):
                    try payload.encode(to: encoder)
                case .value_Variant2(let payload):
                    var container = encoder.singleValueContainer()
                    try container.encode(payload)
                case .value_Variant3(let payload):
                    var container = encoder.singleValueContainer()
                    try container.encode(payload)
                }
            }

            public init(from decoder: Decoder) throws {
                var lastError: Error?
                do {
                    self = .point(try Point(from: decoder))
                    return
                } catch { lastError = error }
                do {
                    self = .value_Variant1(try Value_Variant1(from: decoder))
                    return
                } catch { lastError = error }
                do {
                    self = .value_Variant2(try decoder.singleValueContainer().decode([Point].self))
                    return
                } catch { lastError = error }
                do {
                    self = .value_Variant3(try decoder.singleValueContainer().decode([String: String].self))
                    return
                } catch { lastError = error }
                throw lastError ?? DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "No Value variant matched"))
            }

            private enum EmptyKey: CodingKey {}
        }
    }

    public enum EchoLiteral {

        public struct Value_Variant4: Codable {
            public let size: Double

            public init(size: Double) {
                self.size = size
            }
        }

        public enum Value_Variant3: String, Codable {
            case small
            case large
        }

        public enum Value: Codable {
            case value_Variant0
            case value_Variant1
            case value_Variant2
            case value_Variant3(Value_Variant3)
            case value_Variant4(Value_Variant4)

            public func encode(to encoder: Encoder) throws {
                switch self {
                case .value_Variant0:
                    var container = encoder.singleValueContainer()
                    try container.encode("auto")
                case .value_Variant1:
                    var container = encoder.singleValueContainer()
                    try container.encode(5)
                case .value_Variant2:
                    var container = encoder.singleValueContainer()
                    try container.encode(true)
                case .value_Variant3(let payload):
                    var container = encoder.singleValueContainer()
                    try container.encode(payload)
                case .value_Variant4(let payload):
                    try payload.encode(to: encoder)
                }
            }

            public init(from decoder: Decoder) throws {
                var lastError: Error?
                if let value = try? decoder.singleValueContainer().decode(String.self), value == "auto" {
                    self = .value_Variant0
                    return
                }
                if let value = try? decoder.singleValueContainer().decode(Double.self), value == 5 {
                    self = .value_Variant1
                    return
                }
                if let value = try? decoder.singleValueContainer().decode(Bool.self), value == true {
                    self = .value_Variant2
                    return
                }
                do {
                    self = .value_Variant3(try decoder.singleValueContainer().decode(Value_Variant3.self))
                    return
                } catch { lastError = error }
                do {
                    self = .value_Variant4(try Value_Variant4(from: decoder))
                    return
                } catch { lastError = error }
                throw lastError ?? DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "No Value variant matched"))
            }

            private enum EmptyKey: CodingKey {}
        }

        public struct Result_Variant4: Codable {
            public let size: Double

            public init(size: Double) {
                self.size = size
            }
        }

        public enum Result_Variant3: String, Codable {
            case small
            case large
        }

        public enum Result: Codable {
            case result_Variant0
            case result_Variant1
            case result_Variant2
            case result_Variant3(Result_Variant3)
            case result_Variant4(Result_Variant4)

            public func encode(to encoder: Encoder) throws {
                switch self {
                case .result_Variant0:
                    var container = encoder.singleValueContainer()
                    try container.encode("auto")
                case .result_Variant1:
                    var container = encoder.singleValueContainer()
                    try container.encode(5)
                case .result_Variant2:
                    var container = encoder.singleValueContainer()
                    try container.encode(true)
                case .result_Variant3(let payload):
                    var container = encoder.singleValueContainer()
                    try container.encode(payload)
                case .result_Variant4(let payload):
                    try payload.encode(to: encoder)
                }
            }

            public init(from decoder: Decoder) throws {
                var lastError: Error?
                if let value = try? decoder.singleValueContainer().decode(String.self), value == "auto" {
                    self = .result_Variant0
                    return
                }
                if let value = try? decoder.singleValueContainer().decode(Double.self), value == 5 {
                    self = .result_Variant1
                    return
                }
                if let value = try? decoder.singleValueContainer().decode(Bool.self), value == true {
                    self = .result_Variant2
                    return
                }
                do {
                    self = .result_Variant3(try decoder.singleValueContainer().decode(Result_Variant3.self))
                    return
                } catch { lastError = error }
                do {
                    self = .result_Variant4(try Result_Variant4(from: decoder))
                    return
                } catch { lastError = error }
                throw lastError ?? DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "No Result variant matched"))
            }

            private enum EmptyKey: CodingKey {}
        }
    }

    public enum EchoTagged {

        public struct Circle: Codable {
            public let radius: Double

            public init(radius: Double) {
                self.radius = radius
            }
        }

        public struct Square: Codable {
            public let side: Double

            public init(side: Double) {
                self.side = side
            }
        }

        public enum Value: Codable {
            case value_Variant0(String)
            case circle(Circle)
            case square(Square)

            enum CodingKeys: String, CodingKey {
                case kind
            }

            public func encode(to encoder: Encoder) throws {
                switch self {
                case .value_Variant0(let value):
                    var container = encoder.singleValueContainer()
                    try container.encode(value)
                case .circle(let params):
                    var container = encoder.container(keyedBy: CodingKeys.self)
                    try container.encode("circle", forKey: .kind)
                    try params.encode(to: encoder)
                case .square(let params):
                    var container = encoder.container(keyedBy: CodingKeys.self)
                    try container.encode("square", forKey: .kind)
                    try params.encode(to: encoder)
                }
            }

            public init(from decoder: Decoder) throws {
                if let value = try? decoder.singleValueContainer().decode(String.self) {
                    self = .value_Variant0(value)
                    return
                }
                let container = try decoder.container(keyedBy: CodingKeys.self)
                let disc = try container.decode(String.self, forKey: .kind)
                switch disc {
                case "circle": self = .circle(try Circle(from: decoder))
                case "square": self = .square(try Square(from: decoder))
                default:
                    throw DecodingError.dataCorruptedError(forKey: .kind, in: container, debugDescription: "Unknown value: \(disc)")
                }
            }
        }
    }

    public enum EchoMoment {

        public enum Value: Codable {
            case value_Variant0(Date)
            case value_Variant1(Int)

            public func encode(to encoder: Encoder) throws {
                switch self {
                case .value_Variant0(let payload):
                    var container = encoder.singleValueContainer()
                    try container.encode(payload)
                case .value_Variant1(let payload):
                    var container = encoder.singleValueContainer()
                    try container.encode(payload)
                }
            }

            public init(from decoder: Decoder) throws {
                var lastError: Error?
                do {
                    self = .value_Variant0(try decoder.singleValueContainer().decode(Date.self))
                    return
                } catch { lastError = error }
                do {
                    self = .value_Variant1(try decoder.singleValueContainer().decode(Int.self))
                    return
                } catch { lastError = error }
                throw lastError ?? DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "No Value variant matched"))
            }

            private enum EmptyKey: CodingKey {}
        }
    }

    public enum GetFile {

        public struct Result_Variant1: Codable {
            public let reason: String

            public init(reason: String) {
                self.reason = reason
            }
        }

        public enum Result: Codable {
            case result_Variant0(FileDownloadHandle)
            case result_Variant1(Result_Variant1)

            public func encode(to encoder: Encoder) throws {
                switch self {
                case .result_Variant0(let payload):
                    var container = encoder.singleValueContainer()
                    try container.encode(payload)
                case .result_Variant1(let payload):
                    try payload.encode(to: encoder)
                }
            }

            public init(from decoder: Decoder) throws {
                var lastError: Error?
                do {
                    self = .result_Variant0(try decoder.singleValueContainer().decode(FileDownloadHandle.self))
                    return
                } catch { lastError = error }
                do {
                    self = .result_Variant1(try Result_Variant1(from: decoder))
                    return
                } catch { lastError = error }
                throw lastError ?? DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "No Result variant matched"))
            }

            private enum EmptyKey: CodingKey {}
        }
    }
}


// MARK: - Servers

public enum Servers {
    public static let local = BlocksServer(name: "local", url: "http://localhost:3001/aws-blocks/api")
}