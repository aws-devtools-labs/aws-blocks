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
}

public nonisolated struct CognitoUser: Codable {
    public let attributes: [String: String?]
    public let groups: [String]
    public let userId: String
    public let userSub: String
    public let username: String
}