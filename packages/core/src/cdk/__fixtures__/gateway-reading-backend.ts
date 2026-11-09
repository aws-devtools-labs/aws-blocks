// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A backend whose default export reads the owner's `.gateway` while `create()` is
 * still importing it. The shared gateway is built after the import, so this must
 * fail with the "not fully initialized" error.
 */
export default function (owner: { gateway: unknown }) {
  void owner.gateway;
}
