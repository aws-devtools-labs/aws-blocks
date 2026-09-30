import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FaceLivenessDetectorCore } from '@aws-amplify/ui-react-liveness';
import { ThemeProvider } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';

// Stock Amplify UI <FaceLivenessDetectorCore>, backed by a Blocks app instead
// of an Amplify Gen 2 backend. No amplify_outputs.json, no Identity Pool, no
// Cognito tokens in the browser: sign-in goes through the Blocks auth API
// (session cookie); the Blocks API creates and scores the session, and hands
// the component credentials that can only stream video to Rekognition.

declare const __API_PATH__: string;

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
			setSession(await rpc('liveness.createSession'));
		} catch (err) {
			setError((err as Error).message);
		}
	};

	if (!signedIn) {
		return (
			<main style={{ maxWidth: 360, margin: '4rem auto', fontFamily: 'sans-serif' }}>
				<h1>Face Liveness on Blocks</h1>
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
				<h1>Face Liveness on Blocks</h1>
				{!session && <button onClick={start}>Start liveness check</button>}
				{session && !result && (
					<FaceLivenessDetectorCore
						sessionId={session.sessionId}
						region={session.region}
						config={{
							credentialProvider: async () => {
								const c = await rpc<{ accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: string }>(
									'liveness.getStreamingCredentials',
									session.sessionId,
								);
								return { ...c, expiration: new Date(c.expiration) };
							},
						}}
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
						<p>
							Status {result.status}, confidence {result.confidence?.toFixed(1) ?? 'n/a'} (scored by the Blocks API)
						</p>
						<button onClick={() => { setSession(null); setResult(null); }}>Try again</button>
					</section>
				)}
				{error && <p role="alert">{error}</p>}
			</main>
		</ThemeProvider>
	);
}

createRoot(document.getElementById('root')!).render(<App />);
