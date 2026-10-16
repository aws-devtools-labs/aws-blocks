import Foundation


public struct Doc: Codable {
    public let String: String
    public let __v: Int?
    public let _id: String
    public let fromJson: String
    public let hashCode: Int
    public let int: Int
    public let level: Level
    public let toJson: String
    public let toString: String

    enum CodingKeys: String, CodingKey {
        case String
        case __v
        case _id
        case fromJson
        case hashCode
        case int
        case level
        case toJson
        case toString
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.String, forKey: .String)
        try c.encodeIfPresent(self.__v, forKey: .__v)
        try c.encode(self._id, forKey: ._id)
        try c.encode(self.fromJson, forKey: .fromJson)
        try c.encode(self.hashCode, forKey: .hashCode)
        try c.encode(self.int, forKey: .int)
        try c.encode(self.level, forKey: .level)
        try c.encode(self.toJson, forKey: .toJson)
        try c.encode(self.toString, forKey: .toString)
    }

    public init(String: String, __v: Int? = nil, _id: String, fromJson: String, hashCode: Int, int: Int, level: Level, toJson: String, toString: String) {
        self.String = String
        self.__v = __v
        self._id = _id
        self.fromJson = fromJson
        self.hashCode = hashCode
        self.int = int
        self.level = level
        self.toJson = toJson
        self.toString = toString
    }
}

public struct Extras: Codable {
    public let additionalProperties: String
    public let id: String
    public let attributes: [String: Int]

    public init(additionalProperties: String, id: String, attributes: [String: Int] = [:]) {
        self.additionalProperties = additionalProperties
        self.id = id
        self.attributes = attributes
    }

    private struct DynamicKey: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { return nil }
    }

    private static let fixedFieldNames: Set<String> = [
        "additionalProperties",
        "id",
    ]

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: DynamicKey.self)
        try c.encode(self.additionalProperties, forKey: DynamicKey(stringValue: "additionalProperties")!)
        try c.encode(self.id, forKey: DynamicKey(stringValue: "id")!)
        for (k, v) in self.attributes where !Self.fixedFieldNames.contains(k) {
            try c.encode(v, forKey: DynamicKey(stringValue: k)!)
        }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        self.additionalProperties = try c.decode(String.self, forKey: DynamicKey(stringValue: "additionalProperties")!)
        self.id = try c.decode(String.self, forKey: DynamicKey(stringValue: "id")!)
        var extras: [String: Int] = [:]
        for key in c.allKeys where !Self.fixedFieldNames.contains(key.stringValue) {
            extras[key.stringValue] = try c.decode(Int.self, forKey: key)
        }
        self.attributes = extras
    }
}

public enum Level: String, Codable {
    case values
    case index
    case name
    case _Hidden = "_hidden"
    case ok
}