import Foundation


public nonisolated enum Color: RawRepresentable, Codable, Hashable, Sendable {
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

public nonisolated enum Mode: RawRepresentable, Codable, Hashable, Sendable {
    case auto
    case manual
    /// A value this client was generated without, as the server sent it.
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "auto": self = .auto
        case "manual": self = .manual
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .auto: return "auto"
        case .manual: return "manual"
        case .unknown(let value): return value
        }
    }
}

public nonisolated enum NodeKind: RawRepresentable, Codable, Hashable, Sendable {
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

public nonisolated struct Node: Codable, Sendable {
    public let children: [Node]
    public let kind: NodeKind

    public init(children: [Node], kind: NodeKind) {
        self.children = children
        self.kind = kind
    }
}

public nonisolated enum Size: RawRepresentable, Codable, Hashable, Sendable {
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

public nonisolated enum Status: RawRepresentable, Codable, Hashable, Sendable {
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

public nonisolated enum TaskLabels: RawRepresentable, Codable, Hashable, Sendable {
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

public nonisolated enum TaskPriority: RawRepresentable, Codable, Hashable, Sendable {
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

public nonisolated enum TaskSource: RawRepresentable, Codable, Hashable, Sendable {
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

public nonisolated struct Task: Codable, Sendable {
    public let history: [Status]
    public let id: String
    public let labels: [String: TaskLabels]
    public let priority: TaskPriority?
    public let source: TaskSource?
    public let status: Status

    enum CodingKeys: String, CodingKey {
        case history
        case id
        case labels
        case priority
        case source
        case status
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.history, forKey: .history)
        try c.encode(self.id, forKey: .id)
        try c.encode(self.labels, forKey: .labels)
        try c.encodeIfPresent(self.priority, forKey: .priority)
        try c.encodeIfPresent(self.source, forKey: .source)
        try c.encode(self.status, forKey: .status)
    }

    public init(history: [Status], id: String, labels: [String: TaskLabels], priority: TaskPriority? = nil, source: TaskSource? = nil, status: Status) {
        self.history = history
        self.id = id
        self.labels = labels
        self.priority = priority
        self.source = source
        self.status = status
    }
}