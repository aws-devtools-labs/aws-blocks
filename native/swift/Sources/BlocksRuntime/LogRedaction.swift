//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

extension URL {
    /// The URL as it may appear in a log line: scheme, host, port and path only.
    ///
    /// The query string is dropped because a presigned S3 URL carries its signature and credentials
    /// there (`X-Amz-Signature`, `X-Amz-Credential`, `X-Amz-Security-Token`), and a realtime connect
    /// URL its `token`. User info and the fragment are dropped for the same reason.
    var redactedForLogging: String {
        guard var components = URLComponents(url: self, resolvingAgainstBaseURL: false) else {
            return "<url>"
        }
        components.user = nil
        components.password = nil
        components.query = nil
        components.fragment = nil
        return components.string ?? "<url>"
    }
}
