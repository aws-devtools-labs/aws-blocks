import Foundation
import BlocksRuntime

public class Api {
    private let client: BlocksClient

    public init(server: BlocksServer = Servers.local) {
        self.client = BlocksClient(server: server)
    }

    /// Calls `api.getShipment`.
    public func getShipment(id: String) async throws -> Shipment {
        let request = BlocksRequest(method: "api.getShipment", params: [id], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getShipment") }
        return try JSONDecoder().decode(Shipment.self, from: result)
    }

    /// Calls `api.saveShipment`.
    public func saveShipment(shipment: Shipment) async throws -> Shipment {
        let request = BlocksRequest(method: "api.saveShipment", params: [shipment], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.saveShipment") }
        return try JSONDecoder().decode(Shipment.self, from: result)
    }

    /// Calls `api.getInvoice`.
    public func getInvoice() async throws -> Invoice {
        let request = BlocksRequest(method: "api.getInvoice", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getInvoice") }
        return try JSONDecoder().decode(Invoice.self, from: result)
    }

    /// Calls `api.getReceipt`.
    public func getReceipt() async throws -> Receipt {
        let request = BlocksRequest(method: "api.getReceipt", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.getReceipt") }
        return try JSONDecoder().decode(Receipt.self, from: result)
    }
}


// MARK: - Servers

public enum Servers {
    public static let local = BlocksServer(name: "local", url: "http://localhost:3001/aws-blocks/api")
}