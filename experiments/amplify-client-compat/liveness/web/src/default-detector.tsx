import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
// `aws-amplify`, not `@aws-amplify/core`: <FaceLivenessDetector> reads
// credentials via `fetchAuthSession` from `aws-amplify/auth`, which resolves to
// the core instance nested under aws-amplify@6.17.0 (6.16.3). Configuring the
// top-level core (as Storage needs) would leave the detector unconfigured.
import { Amplify } from 'aws-amplify';
import type { CredentialsAndIdentityIdProvider } from '@aws-amplify/core';
import { FaceLivenessDetector } from '@aws-amplify/ui-react-liveness';
import { ThemeProvider } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';

// Token-exchange spike, Liveness: the DEFAULT <FaceLivenessDetector> (no
// `config.credentialProvider`), which gets credentials from Amplify's own
// fetchAuthSession. Amplify is configured with a credentialsProvider backed by
// the Blocks session cookie. Amplify's provider interface does not carry a
// liveness session id, so the app tells the provider which session is active;
// the Blocks API still checks the caller owns it before vending streaming-only
// credentials. `?noprovider=1` skips the provider to show the detector fails
// without it.

declare const __API_PATH__: string;
const withProvider = !new URLSearchParams(location.search).has('noprovider');

async function rpc<T>(method: string, ...params: unknown[]): Promise<T> {
	const res = await fetch(__API_PATH__, {
		method: 'POST',
		credentials: 'same-origin',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', method, params, id: Date.now() }),
	});
	const body = await res.json();
	if (body.error) throw new Error(body.error.message ?? JSON.stringify(body.error));
	return body.result as T;
}

let activeSessionId: string | undefined;
const stats = { credentialCalls: 0 };
(window as unknown as { __spike: typeof stats }).__spike = stats;

const credentialsProvider: CredentialsAndIdentityIdProvider = {
	async getCredentialsAndIdentityId() {
		if (!activeSessionId) return undefined;
		stats.credentialCalls++;
		const c = await rpc<{ accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: string }>(
			'liveness.getStreamingCredentials',
			activeSessionId,
		);
		return { credentials: { ...c, expiration: new Date(c.expiration) } };
	},
	clearCredentialsAndIdentityId() {
		activeSessionId = undefined;
	},
};
if (withProvider) Amplify.configure({}, { Auth: { credentialsProvider, tokenProvider: { getTokens: async () => null } } });

interface Result { status: string; confidence: number | null; isLive: boolean }

function App() {
	const [signedIn, setSignedIn] = useState(false);
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [session, setSession] = useState<{ sessionId: string; region: string } | null>(null);
	const [result, setResult] = useState<Result | null>(null);
	const [error, setError] = useState('');

	const signIn = async (e: React.FormEvent) => {
		e.preventDefault();
		setError('');
		try {
			const r = await rpc<{ state: string; error?: string }>('authApi.setAuthState', { action: 'signIn', username: email, password });
			if (r.state !== 'signedIn') throw new Error(r.error ?? `sign-in stopped at state ${r.state}`);
			setSignedIn(true);
		} catch (err) {
			setError((err as Error).message);
		}
	};

	const start = async () => {
		setError('');
		setResult(null);
		try {
			const s = await rpc<{ sessionId: string; region: string }>('liveness.createSession');
			activeSessionId = s.sessionId;
			setSession(s);
		} catch (err) {
			setError((err as Error).message);
		}
	};

	if (!signedIn) {
		return (
			<main style={{ maxWidth: 360, margin: '4rem auto', fontFamily: 'sans-serif' }}>
				<h1>Default FaceLivenessDetector on Blocks</h1>
				<form onSubmit={signIn}>
					<label>
						Email
						<input value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" style={{ display: 'block', width: '100%' }} />
					</label>
					<label>
						Password
						<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" style={{ display: 'block', width: '100%' }} />
					</label>
					<button type="submit" style={{ marginTop: 12 }}>Sign in</button>
				</form>
				{error && <p role="alert">{error}</p>}
			</main>
		);
	}

	return (
		<ThemeProvider>
			<main style={{ maxWidth: 720, margin: '2rem auto', fontFamily: 'sans-serif' }}>
				<h1>Default FaceLivenessDetector on Blocks</h1>
				<p data-testid="mode">{withProvider ? 'credentialsProvider: Blocks session' : 'credentialsProvider: none'}</p>
				{!session && <button onClick={start}>Start liveness check</button>}
				{session && !result && (
					<FaceLivenessDetector
						sessionId={session.sessionId}
						region={session.region}
						onAnalysisComplete={async () => {
							setResult(await rpc<Result>('liveness.getResults', session.sessionId));
						}}
						onError={(e) => setError(`${e.state}: ${e.error?.message ?? ''}`)}
						onUserCancel={() => setSession(null)}
					/>
				)}
				{result && (
					<section aria-live="polite">
						<h2>{result.isLive ? 'Live person detected' : 'Not verified as live'}</h2>
						<p>Status {result.status}, confidence {result.confidence?.toFixed(1) ?? 'n/a'} (scored by the Blocks API)</p>
					</section>
				)}
				{error && <p role="alert">{error}</p>}
			</main>
		</ThemeProvider>
	);
}

createRoot(document.getElementById('root')!).render(<App />);
