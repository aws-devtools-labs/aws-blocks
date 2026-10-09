import Foundation


public struct Cart: Codable {
    public let id: String
    public let item: Item
    public let items: [Items]
    public let tags: [String: TagsValue_2]
    public let tagsValue: TagsValue

    public init(id: String, item: Item, items: [Items], tags: [String: TagsValue_2], tagsValue: TagsValue) {
        self.id = id
        self.item = item
        self.items = items
        self.tags = tags
        self.tagsValue = tagsValue
    }

    public struct Item: Codable {
        public let sku: String

        public init(sku: String) {
            self.sku = sku
        }
    }

    public struct Items: Codable {
        public let qty: Double
        public let sku: String

        public init(qty: Double, sku: String) {
            self.qty = qty
            self.sku = sku
        }
    }

    public struct TagsValue_2: Codable {
        public let label: String

        public init(label: String) {
            self.label = label
        }
    }

    public struct TagsValue: Codable {
        public let weight: Double

        public init(weight: Double) {
            self.weight = weight
        }
    }
}

public enum Kind: String, Codable {
    case x
    case y
}

public enum Status: String, Codable {
    case pending
    case shipped
}

public struct Order: Codable {
    public let status: Status

    public init(status: Status) {
        self.status = status
    }
}

public enum TicketKind: String, Codable {
    case bug
    case task
}

public enum Kinds: String, Codable {
    case urgent
    case later
}

public struct Text: Codable {
    public let body: String

    public init(body: String) {
        self.body = body
    }
}

public struct Count: Codable {
    public let total: Double

    public init(total: Double) {
        self.total = total
    }
}

public enum Payload: Codable {
    case text(Text)
    case count(Count)

    enum CodingKeys: String, CodingKey {
        case `type`
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .text(let params):
            try container.encode("text", forKey: .`type`)
            try params.encode(to: encoder)
        case .count(let params):
            try container.encode("count", forKey: .`type`)
            try params.encode(to: encoder)
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let disc = try container.decode(String.self, forKey: .`type`)
        switch disc {
        case "text": self = .text(try Text(from: decoder))
        case "count": self = .count(try Count(from: decoder))
        default:
            throw DecodingError.dataCorruptedError(forKey: .`type`, in: container, debugDescription: "Unknown value: \(disc)")
        }
    }
}

public struct Plain: Codable {
    public let raw: String

    public init(raw: String) {
        self.raw = raw
    }
}

public struct Rich: Codable {
    public let html: String

    public init(html: String) {
        self.html = html
    }
}

public enum Payloads: Codable {
    case plain(Plain)
    case rich(Rich)

    enum CodingKeys: String, CodingKey {
        case format
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .plain(let params):
            try container.encode("plain", forKey: .format)
            try params.encode(to: encoder)
        case .rich(let params):
            try container.encode("rich", forKey: .format)
            try params.encode(to: encoder)
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let disc = try container.decode(String.self, forKey: .format)
        switch disc {
        case "plain": self = .plain(try Plain(from: decoder))
        case "rich": self = .rich(try Rich(from: decoder))
        default:
            throw DecodingError.dataCorruptedError(forKey: .format, in: container, debugDescription: "Unknown value: \(disc)")
        }
    }
}

public enum TicketStatus: String, Codable {
    case open
    case closed
}

public struct Ticket: Codable {
    public let kind: TicketKind
    public let kinds: [Kinds]
    public let payload: Payload
    public let payloads: [Payloads]
    public let status: TicketStatus

    public init(kind: TicketKind, kinds: [Kinds], payload: Payload, payloads: [Payloads], status: TicketStatus) {
        self.kind = kind
        self.kinds = kinds
        self.payload = payload
        self.payloads = payloads
        self.status = status
    }
}