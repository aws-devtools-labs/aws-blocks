import Foundation


public struct Bag: Codable {
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

public enum ProfileState: String, Codable {
    case inProgress = "in-progress"
    case in_Progress = "in_progress"
}

public struct Profile: Codable {
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

    public struct Meta: Codable {
        public let x: String

        public init(x: String) {
            self.x = x
        }
    }

    public struct UserName: Codable {
        public let last: String

        public init(last: String) {
            self.last = last
        }
    }

    public struct User_Name: Codable {
        public let first: String

        public init(first: String) {
            self.first = first
        }
    }
}

public struct Weird: Codable {
    public let back_slash: String

    enum CodingKeys: String, CodingKey {
        case back_slash = "back\\slash"
    }

    public init(back_slash: String) {
        self.back_slash = back_slash
    }
}