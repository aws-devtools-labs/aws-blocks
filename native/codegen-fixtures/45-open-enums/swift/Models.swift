import Foundation


public nonisolated enum ColorValue: RawRepresentable, Codable, Hashable {
    case red
    case blue
    /// A value this client was generated without, as the server sent it.
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "red": self = .red
        case "blue": self = .blue
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .red: return "red"
        case .blue: return "blue"
        case .unknown(let value): return value
        }
    }
}

public nonisolated enum Color: RawRepresentable, Codable, Hashable {
    case red
    case blue
    /// A value this client was generated without, as the server sent it.
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "red": self = .red
        case "blue": self = .blue
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .red: return "red"
        case .blue: return "blue"
        case .unknown(let value): return value
        }
    }
}

public nonisolated enum Kind: RawRepresentable, Codable, Hashable {
    case kind
    case other
    /// A value this client was generated without, as the server sent it.
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "kind": self = .kind
        case "other": self = .other
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .kind: return "kind"
        case .other: return "other"
        case .unknown(let value): return value
        }
    }
}

public nonisolated enum Case: RawRepresentable, Codable, Hashable {
    case fooBar_2
    case foo_Bar
    case fooBar
    case fooBar_3
    case foo_bar
    /// A value this client was generated without, as the server sent it.
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "foo-bar": self = .fooBar_2
        case "foo_bar": self = .foo_Bar
        case "fooBar": self = .fooBar
        case "FOO_BAR": self = .fooBar_3
        case "foo bar": self = .foo_bar
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .fooBar_2: return "foo-bar"
        case .foo_Bar: return "foo_bar"
        case .fooBar: return "fooBar"
        case .fooBar_3: return "FOO_BAR"
        case .foo_bar: return "foo bar"
        case .unknown(let value): return value
        }
    }
}

public nonisolated enum Fallback: RawRepresentable, Codable, Hashable {
    case unknown
    case unknownValue
    case unknownValue_2
    /// A value this client was generated without, as the server sent it.
    case unknownValue2(String)

    public init(rawValue: String) {
        switch rawValue {
        case "unknown": self = .unknown
        case "unknownValue": self = .unknownValue
        case "UnknownValue": self = .unknownValue_2
        default: self = .unknownValue2(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .unknown: return "unknown"
        case .unknownValue: return "unknownValue"
        case .unknownValue_2: return "UnknownValue"
        case .unknownValue2(let value): return value
        }
    }
}

public nonisolated enum Maybe: RawRepresentable, Codable, Hashable {
    case yes
    case no
    /// A value this client was generated without, as the server sent it.
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "yes": self = .yes
        case "no": self = .no
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .yes: return "yes"
        case .no: return "no"
        case .unknown(let value): return value
        }
    }
}

public nonisolated enum Spelling: RawRepresentable, Codable, Hashable {
    case unknown
    case unKnown
    /// A value this client was generated without, as the server sent it.
    case unknownValue(String)

    public init(rawValue: String) {
        switch rawValue {
        case "unknown": self = .unknown
        case "un-known": self = .unKnown
        default: self = .unknownValue(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .unknown: return "unknown"
        case .unKnown: return "un-known"
        case .unknownValue(let value): return value
        }
    }
}

public nonisolated struct Labels: Codable {
    public let `case`: Case
    public let fallback: Fallback
    public let kind: Kind
    public let maybe: Maybe?
    public let spelling: Spelling

    enum CodingKeys: String, CodingKey {
        case `case` = "case"
        case fallback
        case kind
        case maybe
        case spelling
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.`case`, forKey: .`case`)
        try c.encode(self.fallback, forKey: .fallback)
        try c.encode(self.kind, forKey: .kind)
        try c.encodeIfPresent(self.maybe, forKey: .maybe)
        try c.encode(self.spelling, forKey: .spelling)
    }

    public init(`case`: Case, fallback: Fallback, kind: Kind, maybe: Maybe? = nil, spelling: Spelling) {
        self.`case` = `case`
        self.fallback = fallback
        self.kind = kind
        self.maybe = maybe
        self.spelling = spelling
    }
}

public nonisolated enum Mode: String, Codable {
    case auto
    case manual
}

public nonisolated enum NodeKind: RawRepresentable, Codable, Hashable {
    case leaf
    case branch
    /// A value this client was generated without, as the server sent it.
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "leaf": self = .leaf
        case "branch": self = .branch
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .leaf: return "leaf"
        case .branch: return "branch"
        case .unknown(let value): return value
        }
    }
}

public nonisolated struct Node: Codable {
    public let children: [Node]
    public let kind: NodeKind

    public init(children: [Node], kind: NodeKind) {
        self.children = children
        self.kind = kind
    }
}

public nonisolated enum Size: RawRepresentable, Codable, Hashable {
    case small
    case large
    /// A value this client was generated without, as the server sent it.
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "small": self = .small
        case "large": self = .large
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .small: return "small"
        case .large: return "large"
        case .unknown(let value): return value
        }
    }
}

public nonisolated enum Status: RawRepresentable, Codable, Hashable {
    case todo
    case inProgress
    case done
    /// A value this client was generated without, as the server sent it.
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "todo": self = .todo
        case "in-progress": self = .inProgress
        case "done": self = .done
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .todo: return "todo"
        case .inProgress: return "in-progress"
        case .done: return "done"
        case .unknown(let value): return value
        }
    }
}

public nonisolated enum LabelsValue: RawRepresentable, Codable, Hashable {
    case red
    case green
    /// A value this client was generated without, as the server sent it.
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "red": self = .red
        case "green": self = .green
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .red: return "red"
        case .green: return "green"
        case .unknown(let value): return value
        }
    }
}

public nonisolated enum Phase: RawRepresentable, Codable, Hashable {
    case companion
    case other
    /// A value this client was generated without, as the server sent it.
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "companion": self = .companion
        case "other": self = .other
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .companion: return "companion"
        case .other: return "other"
        case .unknown(let value): return value
        }
    }
}

public nonisolated enum Priority: RawRepresentable, Codable, Hashable {
    case low
    case high
    /// A value this client was generated without, as the server sent it.
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "low": self = .low
        case "high": self = .high
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .low: return "low"
        case .high: return "high"
        case .unknown(let value): return value
        }
    }
}

public nonisolated enum Source: RawRepresentable, Codable, Hashable {
    case web
    case unknown
    /// A value this client was generated without, as the server sent it.
    case unknownValue(String)

    public init(rawValue: String) {
        switch rawValue {
        case "web": self = .web
        case "unknown": self = .unknown
        default: self = .unknownValue(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .web: return "web"
        case .unknown: return "unknown"
        case .unknownValue(let value): return value
        }
    }
}

public nonisolated struct Task: Codable {
    public let history: [Status]
    public let id: String
    public let labels: [String: LabelsValue]
    public let phase: Phase?
    public let priority: Priority?
    public let source: Source?
    public let status: Status

    enum CodingKeys: String, CodingKey {
        case history
        case id
        case labels
        case phase
        case priority
        case source
        case status
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.history, forKey: .history)
        try c.encode(self.id, forKey: .id)
        try c.encode(self.labels, forKey: .labels)
        try c.encodeIfPresent(self.phase, forKey: .phase)
        try c.encodeIfPresent(self.priority, forKey: .priority)
        try c.encodeIfPresent(self.source, forKey: .source)
        try c.encode(self.status, forKey: .status)
    }

    public init(history: [Status], id: String, labels: [String: LabelsValue], phase: Phase? = nil, priority: Priority? = nil, source: Source? = nil, status: Status) {
        self.history = history
        self.id = id
        self.labels = labels
        self.phase = phase
        self.priority = priority
        self.source = source
        self.status = status
    }
}