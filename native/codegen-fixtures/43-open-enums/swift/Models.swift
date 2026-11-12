import Foundation


public nonisolated enum Status: String, Codable {
    case todo
    case inProgress = "in-progress"
    case done
}

public nonisolated enum LabelsValue: String, Codable {
    case red
    case green
}

public nonisolated enum Priority: String, Codable {
    case low
    case high
}

public nonisolated enum Source: String, Codable {
    case web
    case unknown
}

public nonisolated struct Task: Codable {
    public let history: [Status]
    public let id: String
    public let labels: [String: LabelsValue]
    public let priority: Priority?
    public let source: Source?
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

    public init(history: [Status], id: String, labels: [String: LabelsValue], priority: Priority? = nil, source: Source? = nil, status: Status) {
        self.history = history
        self.id = id
        self.labels = labels
        self.priority = priority
        self.source = source
        self.status = status
    }
}