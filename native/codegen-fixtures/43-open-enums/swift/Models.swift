import Foundation


public nonisolated enum Status: String, Codable, Sendable {
    case todo
    case inProgress = "in-progress"
    case done
}

public nonisolated enum TaskLabels: String, Codable, Sendable {
    case red
    case green
}

public nonisolated enum TaskPriority: String, Codable, Sendable {
    case low
    case high
}

public nonisolated enum TaskSource: String, Codable, Sendable {
    case web
    case unknown
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