import Foundation


public nonisolated struct Bag: Codable, Sendable {
    public let attributes: String
    public let attributes_2: [String: String]

    public init(attributes: String, attributes_2: [String: String] = [:]) {
        self.attributes = attributes
        self.attributes_2 = attributes_2
    }

    private struct DynamicKey: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { return nil }
    }

    private static let fixedFieldNames: Set<String> = [
        "attributes",
    ]

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: DynamicKey.self)
        try c.encode(self.attributes, forKey: DynamicKey(stringValue: "attributes")!)
        for (k, v) in self.attributes_2 where !Self.fixedFieldNames.contains(k) {
            try c.encode(v, forKey: DynamicKey(stringValue: k)!)
        }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        self.attributes = try c.decode(String.self, forKey: DynamicKey(stringValue: "attributes")!)
        var extras: [String: String] = [:]
        for key in c.allKeys where !Self.fixedFieldNames.contains(key.stringValue) {
            extras[key.stringValue] = try c.decode(String.self, forKey: key)
        }
        self.attributes_2 = extras
    }
}

public nonisolated enum ProfileState: RawRepresentable, Codable, Hashable, Sendable {
    case inProgress
    case in_Progress
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "in-progress": self = .inProgress
        case "in_progress": self = .in_Progress
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .inProgress: return "in-progress"
        case .in_Progress: return "in_progress"
        case .unknown(let value): return value
        }
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        switch (lhs, rhs) {
        case (.inProgress, .inProgress): return true
        case (.in_Progress, .in_Progress): return true
        case let (.unknown(lhs), .unknown(rhs)): return lhs == rhs
        default: return false
        }
    }

    public func hash(into hasher: inout Hasher) {
        switch self {
        case .inProgress: hasher.combine(0)
        case .in_Progress: hasher.combine(1)
        case .unknown(let value):
            hasher.combine(2)
            hasher.combine(value)
        }
    }
}

public nonisolated struct Profile: Codable, Sendable {
    public let Meta: Meta
    public let state: ProfileState
    public let userName: UserName
    public let user_name: User_Name

    public init(Meta: Meta, state: ProfileState, userName: UserName, user_name: User_Name) {
        self.Meta = Meta
        self.state = state
        self.userName = userName
        self.user_name = user_name
    }

    public nonisolated struct Meta: Codable, Sendable {
        public let x: String

        public init(x: String) {
            self.x = x
        }
    }

    public nonisolated struct UserName: Codable, Sendable {
        public let last: String

        public init(last: String) {
            self.last = last
        }
    }

    public nonisolated struct User_Name: Codable, Sendable {
        public let first: String

        public init(first: String) {
            self.first = first
        }
    }
}

public nonisolated struct Weird: Codable, Sendable {
    public let back_slash: String

    enum CodingKeys: String, CodingKey {
        case back_slash = "back\\slash"
    }

    public init(back_slash: String) {
        self.back_slash = back_slash
    }
}