import Foundation
import BlocksRuntime


public struct Board: Codable {
    public let channels: [RealtimeChannel<Note>]
    public let downloads: [FileDownloadHandle]
    public let feedsByRoom: [String: RealtimeChannel<Note>]
    public let layout: Layout
    public let tagFeeds: [RealtimeChannel<[String]>]?
    public let title: String

    enum CodingKeys: String, CodingKey {
        case channels
        case downloads
        case feedsByRoom
        case layout
        case tagFeeds
        case title
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.channels, forKey: .channels)
        try c.encode(self.downloads, forKey: .downloads)
        try c.encode(self.feedsByRoom, forKey: .feedsByRoom)
        try c.encode(self.layout, forKey: .layout)
        try c.encodeIfPresent(self.tagFeeds, forKey: .tagFeeds)
        try c.encode(self.title, forKey: .title)
    }

    public init(channels: [RealtimeChannel<Note>], downloads: [FileDownloadHandle], feedsByRoom: [String: RealtimeChannel<Note>], layout: Layout, tagFeeds: [RealtimeChannel<[String]>]? = nil, title: String) {
        self.channels = channels
        self.downloads = downloads
        self.feedsByRoom = feedsByRoom
        self.layout = layout
        self.tagFeeds = tagFeeds
        self.title = title
    }
}

public struct Layout: Codable {
    public let grid: [[Note]]
    public let levels: [Level]
    public let levelsByUser: [String: [Level]]?
    public let matrix: [[Int]]
    public let maybeNotes: [Note?]
    public let nestedLevels: [String: [String: Level]]
    public let notesByTag: [String: [Note]]
    public let pages: [[String: Note]]
    public let scoresByUser: [String: [Int]]?
    public let tagsByUser: [String: [String]]

    enum CodingKeys: String, CodingKey {
        case grid
        case levels
        case levelsByUser
        case matrix
        case maybeNotes
        case nestedLevels
        case notesByTag
        case pages
        case scoresByUser
        case tagsByUser
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.grid, forKey: .grid)
        try c.encode(self.levels, forKey: .levels)
        try c.encodeIfPresent(self.levelsByUser, forKey: .levelsByUser)
        try c.encode(self.matrix, forKey: .matrix)
        try c.encode(self.maybeNotes, forKey: .maybeNotes)
        try c.encode(self.nestedLevels, forKey: .nestedLevels)
        try c.encode(self.notesByTag, forKey: .notesByTag)
        try c.encode(self.pages, forKey: .pages)
        try c.encodeIfPresent(self.scoresByUser, forKey: .scoresByUser)
        try c.encode(self.tagsByUser, forKey: .tagsByUser)
    }

    public init(grid: [[Note]], levels: [Level], levelsByUser: [String: [Level]]? = nil, matrix: [[Int]], maybeNotes: [Note?], nestedLevels: [String: [String: Level]], notesByTag: [String: [Note]], pages: [[String: Note]], scoresByUser: [String: [Int]]? = nil, tagsByUser: [String: [String]]) {
        self.grid = grid
        self.levels = levels
        self.levelsByUser = levelsByUser
        self.matrix = matrix
        self.maybeNotes = maybeNotes
        self.nestedLevels = nestedLevels
        self.notesByTag = notesByTag
        self.pages = pages
        self.scoresByUser = scoresByUser
        self.tagsByUser = tagsByUser
    }
}

public enum Level: String, Codable {
    case low
    case high
}

public struct LoginMenu: Codable {
    public let fallback: OIDCClient?
    public let options: [SignInOption]
    public let primary: SignInOption

    enum CodingKeys: String, CodingKey {
        case fallback
        case options
        case primary
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(self.fallback, forKey: .fallback)
        try c.encode(self.options, forKey: .options)
        try c.encode(self.primary, forKey: .primary)
    }

    public init(fallback: OIDCClient? = nil, options: [SignInOption], primary: SignInOption) {
        self.fallback = fallback
        self.options = options
        self.primary = primary
    }
}

public struct Note: Codable {
    public let body: String
    public let id: String

    public init(body: String, id: String) {
        self.body = body
        self.id = id
    }
}

public struct SignInOption: Codable {
    public let client: OIDCClient
    public let label: String

    public init(client: OIDCClient, label: String) {
        self.client = client
        self.label = label
    }
}