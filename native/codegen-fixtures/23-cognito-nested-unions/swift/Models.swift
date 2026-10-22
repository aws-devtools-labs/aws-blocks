import Foundation


public nonisolated enum DeliveryMedium: String, Codable {
    case sms = "SMS"
    case email = "EMAIL"
    case phoneNumber = "PHONE_NUMBER"
}

public nonisolated struct CodeDeliveryDetails: Codable {
    public let attributeName: String
    public let deliveryMedium: DeliveryMedium
    public let destination: String

    public init(attributeName: String, deliveryMedium: DeliveryMedium, destination: String) {
        self.attributeName = attributeName
        self.deliveryMedium = deliveryMedium
        self.destination = destination
    }
}

public nonisolated struct CognitoUser: Codable {
    public let attributes: [String: String?]
    public let groups: [String]
    public let userId: String
    public let userSub: String
    public let username: String

    public init(attributes: [String: String?], groups: [String], userId: String, userSub: String, username: String) {
        self.attributes = attributes
        self.groups = groups
        self.userId = userId
        self.userSub = userSub
        self.username = username
    }
}