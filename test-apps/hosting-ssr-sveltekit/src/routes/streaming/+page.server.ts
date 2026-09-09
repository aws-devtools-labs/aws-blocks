// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { PageServerLoad } from './$types';

// SvelteKit streams unawaited promises returned from load: the shell renders
// immediately and the deferred value is streamed in. This exercises the LWA
// response_stream path end to end.
export const load: PageServerLoad = () => {
  return {
    eager: 'shell-ready',
    deferred: new Promise<string>((resolve) =>
      setTimeout(() => resolve(`streamed-${Date.now()}`), 400),
    ),
  };
};
