// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
'use client';

import { useState } from 'react';
import { MARKER } from 'nextjs-resolution-aws-blocks';
import { probeAction } from './actions';

export function ClientProbe() {
	// Compiled twice. The rendered HTML shows the SSR-pass resolution (`import`);
	// the browser chunk shows the browser-bundle resolution (`browser`).
	//
	// The button exists so `probeAction` is referenced from client code — an
	// unreferenced Server Action is never registered, so it gets no action id and
	// cannot be invoked over HTTP by the test.
	const [result, setResult] = useState('');
	return (
		<>
			<p id="client">client={MARKER}</p>
			<button type="button" onClick={async () => setResult(JSON.stringify(await probeAction()))}>
				run action
			</button>
			<p id="action">action={result}</p>
		</>
	);
}
