import Foundation
import BlocksRuntime


public nonisolated struct Sms: Codable, Sendable {
    public let code: String

    public init(code: String) {
        self.code = code
    }
}

public nonisolated struct Totp: Codable, Sendable {
    public let otp: String

    public init(otp: String) {
        self.otp = otp
    }
}

public nonisolated enum ConfirmChallenge: Codable, Sendable {
    case sms(Sms)
    case totp(Totp)

    enum CodingKeys: String, CodingKey {
        case challenge
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .sms(let params):
            try container.encode("sms", forKey: .challenge)
            try params.encode(to: encoder)
        case .totp(let params):
            try container.encode("totp", forKey: .challenge)
            try params.encode(to: encoder)
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let disc = try container.decode(String.self, forKey: .challenge)
        switch disc {
        case "sms": self = .sms(try Sms(from: decoder))
        case "totp": self = .totp(try Totp(from: decoder))
        default:
            throw DecodingError.dataCorruptedError(forKey: .challenge, in: container, debugDescription: "Unknown value: \(disc)")
        }
    }
}

public nonisolated struct Confirm: Codable, Sendable {
    public let session: String
    public let challenge: ConfirmChallenge

    public init(session: String, challenge: ConfirmChallenge) {
        self.session = session
        self.challenge = challenge
    }

    private enum OuterCodingKeys: String, CodingKey {
        case session
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: OuterCodingKeys.self)
        try c.encode(self.session, forKey: .session)
        try self.challenge.encode(to: encoder)
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: OuterCodingKeys.self)
        self.session = try c.decode(String.self, forKey: .session)
        self.challenge = try ConfirmChallenge(from: decoder)
    }
}

public nonisolated enum AuthStep: Codable, Sendable {
    case done
    case confirm(Confirm)
    case unknown(JSONValue)

    enum CodingKeys: String, CodingKey {
        case step
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .done:
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode("done", forKey: .step)
        case .confirm(let params):
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode("confirm", forKey: .step)
            try params.encode(to: encoder)
        case .unknown(let value):
            try value.encode(to: encoder)
        }
    }

    public var unknownDiscriminator: String? {
        guard case .unknown(.dictionary(let object)) = self,
              case .string(let tag)? = object["step"] else { return nil }
        return tag
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let disc = try container.decode(String.self, forKey: .step)
        switch disc {
        case "done": self = .done
        case "confirm": self = .confirm(try Confirm(from: decoder))
        default:
            self = .unknown(try JSONValue(from: decoder))
        }
    }
}

public nonisolated enum Color: RawRepresentable, Codable, Hashable, Sendable {
    case red
    case blue
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

    public static func == (lhs: Self, rhs: Self) -> Bool {
        switch (lhs, rhs) {
        case (.red, .red): return true
        case (.blue, .blue): return true
        case let (.unknown(lhs), .unknown(rhs)): return lhs == rhs
        default: return false
        }
    }

    public func hash(into hasher: inout Hasher) {
        switch self {
        case .red: hasher.combine(0)
        case .blue: hasher.combine(1)
        case .unknown(let value):
            hasher.combine(2)
            hasher.combine(value)
        }
    }
}

public nonisolated enum FailedState: String, Codable, Sendable {
    case error
}

public nonisolated struct Failed: Codable, Sendable {
    public let message: String
    public let state: FailedState

    public init(message: String, state: FailedState) {
        self.message = message
        self.state = state
    }
}

public nonisolated enum Kind: RawRepresentable, Codable, Hashable, Sendable {
    case kind
    case other
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

    public static func == (lhs: Self, rhs: Self) -> Bool {
        switch (lhs, rhs) {
        case (.kind, .kind): return true
        case (.other, .other): return true
        case let (.unknown(lhs), .unknown(rhs)): return lhs == rhs
        default: return false
        }
    }

    public func hash(into hasher: inout Hasher) {
        switch self {
        case .kind: hasher.combine(0)
        case .other: hasher.combine(1)
        case .unknown(let value):
            hasher.combine(2)
            hasher.combine(value)
        }
    }
}

public nonisolated enum LabelsCase: RawRepresentable, Codable, Hashable, Sendable {
    case fooBar_2
    case foo_Bar
    case fooBar
    case fooBar_3
    case foo_bar
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

    public static func == (lhs: Self, rhs: Self) -> Bool {
        switch (lhs, rhs) {
        case (.fooBar_2, .fooBar_2): return true
        case (.foo_Bar, .foo_Bar): return true
        case (.fooBar, .fooBar): return true
        case (.fooBar_3, .fooBar_3): return true
        case (.foo_bar, .foo_bar): return true
        case let (.unknown(lhs), .unknown(rhs)): return lhs == rhs
        default: return false
        }
    }

    public func hash(into hasher: inout Hasher) {
        switch self {
        case .fooBar_2: hasher.combine(0)
        case .foo_Bar: hasher.combine(1)
        case .fooBar: hasher.combine(2)
        case .fooBar_3: hasher.combine(3)
        case .foo_bar: hasher.combine(4)
        case .unknown(let value):
            hasher.combine(5)
            hasher.combine(value)
        }
    }
}

public nonisolated enum LabelsFallback: RawRepresentable, Codable, Hashable, Sendable {
    case unknown
    case unknownValue
    case unknownValue_2
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

    public static func == (lhs: Self, rhs: Self) -> Bool {
        switch (lhs, rhs) {
        case (.unknown, .unknown): return true
        case (.unknownValue, .unknownValue): return true
        case (.unknownValue_2, .unknownValue_2): return true
        case let (.unknownValue2(lhs), .unknownValue2(rhs)): return lhs == rhs
        default: return false
        }
    }

    public func hash(into hasher: inout Hasher) {
        switch self {
        case .unknown: hasher.combine(0)
        case .unknownValue: hasher.combine(1)
        case .unknownValue_2: hasher.combine(2)
        case .unknownValue2(let value):
            hasher.combine(3)
            hasher.combine(value)
        }
    }
}

public nonisolated enum LabelsMaybe: RawRepresentable, Codable, Hashable, Sendable {
    case yes
    case no
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

    public static func == (lhs: Self, rhs: Self) -> Bool {
        switch (lhs, rhs) {
        case (.yes, .yes): return true
        case (.no, .no): return true
        case let (.unknown(lhs), .unknown(rhs)): return lhs == rhs
        default: return false
        }
    }

    public func hash(into hasher: inout Hasher) {
        switch self {
        case .yes: hasher.combine(0)
        case .no: hasher.combine(1)
        case .unknown(let value):
            hasher.combine(2)
            hasher.combine(value)
        }
    }
}

public nonisolated enum LabelsSpelling: RawRepresentable, Codable, Hashable, Sendable {
    case unknown
    case unKnown
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

    public static func == (lhs: Self, rhs: Self) -> Bool {
        switch (lhs, rhs) {
        case (.unknown, .unknown): return true
        case (.unKnown, .unKnown): return true
        case let (.unknownValue(lhs), .unknownValue(rhs)): return lhs == rhs
        default: return false
        }
    }

    public func hash(into hasher: inout Hasher) {
        switch self {
        case .unknown: hasher.combine(0)
        case .unKnown: hasher.combine(1)
        case .unknownValue(let value):
            hasher.combine(2)
            hasher.combine(value)
        }
    }
}

public nonisolated struct Labels: Codable, Sendable {
    public let `case`: LabelsCase
    public let fallback: LabelsFallback
    public let kind: Kind
    public let maybe: LabelsMaybe?
    public let spelling: LabelsSpelling

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

    public init(`case`: LabelsCase, fallback: LabelsFallback, kind: Kind, maybe: LabelsMaybe? = nil, spelling: LabelsSpelling) {
        self.`case` = `case`
        self.fallback = fallback
        self.kind = kind
        self.maybe = maybe
        self.spelling = spelling
    }
}

public nonisolated enum Mode: String, Codable, Sendable {
    case auto
    case manual
}

public nonisolated enum NodeKind: RawRepresentable, Codable, Hashable, Sendable {
    case leaf
    case branch
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

    public static func == (lhs: Self, rhs: Self) -> Bool {
        switch (lhs, rhs) {
        case (.leaf, .leaf): return true
        case (.branch, .branch): return true
        case let (.unknown(lhs), .unknown(rhs)): return lhs == rhs
        default: return false
        }
    }

    public func hash(into hasher: inout Hasher) {
        switch self {
        case .leaf: hasher.combine(0)
        case .branch: hasher.combine(1)
        case .unknown(let value):
            hasher.combine(2)
            hasher.combine(value)
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

public nonisolated enum PendingState: String, Codable, Sendable {
    case idle
    case loading
}

public nonisolated enum PendingSteps: String, Codable, Sendable {
    case fetch
    case parse
}

public nonisolated struct Pending: Codable, Sendable {
    public let state: PendingState
    public let steps: [PendingSteps]?

    enum CodingKeys: String, CodingKey {
        case state
        case steps
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.state, forKey: .state)
        try c.encodeIfPresent(self.steps, forKey: .steps)
    }

    public init(state: PendingState, steps: [PendingSteps]? = nil) {
        self.state = state
        self.steps = steps
    }
}

public nonisolated enum Size: RawRepresentable, Codable, Hashable, Sendable {
    case small
    case large
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

    public static func == (lhs: Self, rhs: Self) -> Bool {
        switch (lhs, rhs) {
        case (.small, .small): return true
        case (.large, .large): return true
        case let (.unknown(lhs), .unknown(rhs)): return lhs == rhs
        default: return false
        }
    }

    public func hash(into hasher: inout Hasher) {
        switch self {
        case .small: hasher.combine(0)
        case .large: hasher.combine(1)
        case .unknown(let value):
            hasher.combine(2)
            hasher.combine(value)
        }
    }
}

public nonisolated enum Status: RawRepresentable, Codable, Hashable, Sendable {
    case todo
    case inProgress
    case done
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

    public static func == (lhs: Self, rhs: Self) -> Bool {
        switch (lhs, rhs) {
        case (.todo, .todo): return true
        case (.inProgress, .inProgress): return true
        case (.done, .done): return true
        case let (.unknown(lhs), .unknown(rhs)): return lhs == rhs
        default: return false
        }
    }

    public func hash(into hasher: inout Hasher) {
        switch self {
        case .todo: hasher.combine(0)
        case .inProgress: hasher.combine(1)
        case .done: hasher.combine(2)
        case .unknown(let value):
            hasher.combine(3)
            hasher.combine(value)
        }
    }
}

public nonisolated enum TaskLabels: RawRepresentable, Codable, Hashable, Sendable {
    case red
    case green
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

    public static func == (lhs: Self, rhs: Self) -> Bool {
        switch (lhs, rhs) {
        case (.red, .red): return true
        case (.green, .green): return true
        case let (.unknown(lhs), .unknown(rhs)): return lhs == rhs
        default: return false
        }
    }

    public func hash(into hasher: inout Hasher) {
        switch self {
        case .red: hasher.combine(0)
        case .green: hasher.combine(1)
        case .unknown(let value):
            hasher.combine(2)
            hasher.combine(value)
        }
    }
}

public nonisolated enum TaskPhase: RawRepresentable, Codable, Hashable, Sendable {
    case companion
    case other
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

    public static func == (lhs: Self, rhs: Self) -> Bool {
        switch (lhs, rhs) {
        case (.companion, .companion): return true
        case (.other, .other): return true
        case let (.unknown(lhs), .unknown(rhs)): return lhs == rhs
        default: return false
        }
    }

    public func hash(into hasher: inout Hasher) {
        switch self {
        case .companion: hasher.combine(0)
        case .other: hasher.combine(1)
        case .unknown(let value):
            hasher.combine(2)
            hasher.combine(value)
        }
    }
}

public nonisolated enum TaskPriority: RawRepresentable, Codable, Hashable, Sendable {
    case low
    case high
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

    public static func == (lhs: Self, rhs: Self) -> Bool {
        switch (lhs, rhs) {
        case (.low, .low): return true
        case (.high, .high): return true
        case let (.unknown(lhs), .unknown(rhs)): return lhs == rhs
        default: return false
        }
    }

    public func hash(into hasher: inout Hasher) {
        switch self {
        case .low: hasher.combine(0)
        case .high: hasher.combine(1)
        case .unknown(let value):
            hasher.combine(2)
            hasher.combine(value)
        }
    }
}

public nonisolated enum TaskSource: RawRepresentable, Codable, Hashable, Sendable {
    case web
    case unknown
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

    public static func == (lhs: Self, rhs: Self) -> Bool {
        switch (lhs, rhs) {
        case (.web, .web): return true
        case (.unknown, .unknown): return true
        case let (.unknownValue(lhs), .unknownValue(rhs)): return lhs == rhs
        default: return false
        }
    }

    public func hash(into hasher: inout Hasher) {
        switch self {
        case .web: hasher.combine(0)
        case .unknown: hasher.combine(1)
        case .unknownValue(let value):
            hasher.combine(2)
            hasher.combine(value)
        }
    }
}

public nonisolated struct Task: Codable, Sendable {
    public let history: [Status]
    public let id: String
    public let labels: [String: TaskLabels]
    public let phase: TaskPhase?
    public let priority: TaskPriority?
    public let source: TaskSource?
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

    public init(history: [Status], id: String, labels: [String: TaskLabels], phase: TaskPhase? = nil, priority: TaskPriority? = nil, source: TaskSource? = nil, status: Status) {
        self.history = history
        self.id = id
        self.labels = labels
        self.phase = phase
        self.priority = priority
        self.source = source
        self.status = status
    }
}