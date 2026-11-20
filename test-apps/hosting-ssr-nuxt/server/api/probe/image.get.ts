// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// A 1×1 PNG. Its bytes include NUL and bytes above 0x7f, so any text decode
// between the server and the client changes them.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

export default defineEventHandler((event) => {
  setResponseHeader(event, 'content-type', 'image/png');
  return Buffer.from(PNG_BASE64, 'base64');
});
