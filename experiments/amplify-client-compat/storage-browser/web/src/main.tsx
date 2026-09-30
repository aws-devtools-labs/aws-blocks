import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createStorageBrowser } from '@aws-amplify/ui-react-storage/browser';
import '@aws-amplify/ui-react-storage/styles.css';

// Stock Amplify UI <StorageBrowser>, backed by a Blocks app instead of an
// Amplify Gen 2 backend. No amplify_outputs.json, no Identity Pool, and no
// Cognito tokens in the browser: sign-in goes through the Blocks auth API
// (session cookie), and every S3 call uses short-lived credentials the Blocks
// API mints for one location at a time.

declare const __REGION__: string;
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

let onAuthChange: (() => void) | undefined;

const { StorageBrowser } = createStorageBrowser({
	config: {
		region: __REGION__,
		registerAuthListener: (cb) => {
			onAuthChange = cb;
		},
		listLocations: async () => {
			const r = await rpc<{ items: any[] }>('storage.listLocations');
			return { items: r.items, nextToken: undefined };
		},
		getLocationCredentials: async ({ scope, permissions }) => {
			const r = await rpc<{ credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: string } }>(
				'storage.getLocationCredentials',
				{ scope, permissions },
			);
			return { credentials: { ...r.credentials, expiration: new Date(r.credentials.expiration) } };
		},
	},
});

function App() {
	const [signedIn, setSignedIn] = useState(false);
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
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

	const signOut = async () => {
		await rpc('authApi.setAuthState', { action: 'signOut' }).catch(() => undefined);
		onAuthChange?.(); // tells StorageBrowser to drop cached credentials
		setSignedIn(false);
	};

	if (!signedIn) {
		return (
			<main style={{ maxWidth: 360, margin: '4rem auto', fontFamily: 'sans-serif' }}>
				<h1>StorageBrowser on Blocks</h1>
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
		<main style={{ padding: 16, fontFamily: 'sans-serif' }}>
			<button onClick={signOut}>Sign out</button>
			<StorageBrowser />
		</main>
	);
}

createRoot(document.getElementById('root')!).render(<App />);
