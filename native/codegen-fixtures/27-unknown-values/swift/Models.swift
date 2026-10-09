import Foundation
import BlocksRuntime


public struct Entry: Codable {
    public let claims: [String: JSONValue]?
    public let metadata: [String: JSONValue]
    public let nullablePayload: JSONValue?
    public let optionalPayload: JSONValue?
    public let payload: JSONValue
    public let sparse: [String: JSONValue?]
    public let tags: [JSONValue]

    enum CodingKeys: String, CodingKey {
        case claims
        case metadata
        case nullablePayload
        case optionalPayload
        case payload
        case sparse
        case tags
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(self.claims, forKey: .claims)
        try c.encode(self.metadata, forKey: .metadata)
        try c.encodeIfPresent(self.nullablePayload, forKey: .nullablePayload)
        try c.encodeIfPresent(self.optionalPayload, forKey: .optionalPayload)
        try c.encode(self.payload, forKey: .payload)
        try c.encode(self.sparse, forKey: .sparse)
        try c.encode(self.tags, forKey: .tags)
    }

    public init(claims: [String: JSONValue]? = nil, metadata: [String: JSONValue], nullablePayload: JSONValue? = nil, optionalPayload: JSONValue? = nil, payload: JSONValue, sparse: [String: JSONValue?], tags: [JSONValue]) {
        self.claims = claims
        self.metadata = metadata
        self.nullablePayload = nullablePayload
        self.optionalPayload = optionalPayload
        self.payload = payload
        self.sparse = sparse
        self.tags = tags
    }
}