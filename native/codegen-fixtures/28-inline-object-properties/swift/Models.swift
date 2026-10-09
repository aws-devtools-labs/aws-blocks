import Foundation


public struct Invoice: Codable {
    public let id: String
    public let meta: Meta

    public init(id: String, meta: Meta) {
        self.id = id
        self.meta = meta
    }

    public struct Meta: Codable {
        public let value: Int

        public init(value: Int) {
            self.value = value
        }
    }
}

public struct Receipt: Codable {
    public let id: String
    public let meta: Meta

    public init(id: String, meta: Meta) {
        self.id = id
        self.meta = meta
    }

    public struct Meta: Codable {
        public let value: String

        public init(value: String) {
            self.value = value
        }
    }
}

public struct Shipment: Codable {
    public let customs: [String: CustomsValue]?
    public let destination: Destination
    public let id: String
    public let insurance: Insurance?
    public let parcels: [Parcel]
    public let signature: Signature?

    enum CodingKeys: String, CodingKey {
        case customs
        case destination
        case id
        case insurance
        case parcels
        case signature
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(self.customs, forKey: .customs)
        try c.encode(self.destination, forKey: .destination)
        try c.encode(self.id, forKey: .id)
        try c.encodeIfPresent(self.insurance, forKey: .insurance)
        try c.encode(self.parcels, forKey: .parcels)
        try c.encodeIfPresent(self.signature, forKey: .signature)
    }

    public init(customs: [String: CustomsValue]? = nil, destination: Destination, id: String, insurance: Insurance? = nil, parcels: [Parcel], signature: Signature? = nil) {
        self.customs = customs
        self.destination = destination
        self.id = id
        self.insurance = insurance
        self.parcels = parcels
        self.signature = signature
    }

    public struct CustomsValue: Codable {
        public let code: String
        public let value: Double

        public init(code: String, value: Double) {
            self.code = code
            self.value = value
        }
    }

    public struct Destination: Codable {
        public let city: String
        public let geo: Geo

        public init(city: String, geo: Geo) {
            self.city = city
            self.geo = geo
        }

        public struct Geo: Codable {
            public let accuracy: Accuracy?
            public let lat: Double
            public let lng: Double

            enum CodingKeys: String, CodingKey {
                case accuracy
                case lat
                case lng
            }

            public func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                try c.encodeIfPresent(self.accuracy, forKey: .accuracy)
                try c.encode(self.lat, forKey: .lat)
                try c.encode(self.lng, forKey: .lng)
            }

            public init(accuracy: Accuracy? = nil, lat: Double, lng: Double) {
                self.accuracy = accuracy
                self.lat = lat
                self.lng = lng
            }

            public struct Accuracy: Codable {
                public let meters: Double
                public let source: Source

                public init(meters: Double, source: Source) {
                    self.meters = meters
                    self.source = source
                }

                public enum Source: String, Codable {
                    case gps
                    case cell
                }
            }
        }
    }

    public struct Insurance: Codable {
        public let amount: Double?
        public let provider: String

        enum CodingKeys: String, CodingKey {
            case amount
            case provider
        }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encodeIfPresent(self.amount, forKey: .amount)
            try c.encode(self.provider, forKey: .provider)
        }

        public init(amount: Double? = nil, provider: String) {
            self.amount = amount
            self.provider = provider
        }
    }

    public struct Parcel: Codable {
        public let sku: String
        public let weightKg: Double

        public init(sku: String, weightKg: Double) {
            self.sku = sku
            self.weightKg = weightKg
        }
    }

    public struct Signature: Codable {
        public let signedAt: String
        public let signedBy: String

        public init(signedAt: String, signedBy: String) {
            self.signedAt = signedAt
            self.signedBy = signedBy
        }
    }
}