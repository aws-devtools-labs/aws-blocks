//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

// Compile-only stub of the declared `example-iot-native` Swift module (see ../README.md).
import Foundation

public struct DeviceHandle {
    public static func fromBlocksDescriptor(_ descriptor: [String: Any]) throws -> DeviceHandle {
        DeviceHandle()
    }
}

public struct DeviceLink<Message> {
    public static func fromBlocksDescriptor(
        _ descriptor: [String: Any],
        decode: @escaping (Data) throws -> Message
    ) throws -> DeviceLink<Message> {
        DeviceLink()
    }
}
