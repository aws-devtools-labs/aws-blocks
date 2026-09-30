import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Amplify } from 'aws-amplify';
import { signIn, signOut, fetchAuthSession } from 'aws-amplify/auth';
import { emitAmplifyOutputs, type BlocksCognitoFacts } from '../../../src/emit-amplify-outputs.js';

// Stock aws-amplify@6 Auth client against a Blocks-provisioned Cognito pool.
// There is no Amplify backend and no ampx: the Blocks `Hosting` block publishes
// the pool's public identifiers in /.blocks-sandbox/config.json, and the
// experiment's emitter turns them into amplify_outputs.json in the browser.

const RPC = '/aws-blocks/api';

interface Step { label: string; ok: boolean | null; detail: string }

async function rpc(method: string, params: unknown[], headers: Record<string, string> = {}) {
	const res = await fetch(RPC, {
		method: 'POST',
		credentials: 'same-origin',
		headers: { 'content-type': 'application/json', ...headers },
		body: JSON.stringify({ jsonrpc: '2.0', method, params, id: Date.now() }),
	});
	return (await res.json()) as { result?: unknown; error?: { code: number; message: string } };
}

function App() {
	const [facts, setFacts] = useState<BlocksCognitoFacts | null>(null);
	const [outputsJson, setOutputsJson] = useState('');
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [steps, setSteps] = useState<Step[]>([]);
	const [busy, setBusy] = useState(false);
	const [loadError, setLoadError] = useState('');

	useEffect(() => {
		fetch('/.blocks-sandbox/config.json')
			.then((r) => r.json())
			.then((cfg: Record<string, string>) => {
				const f: BlocksCognitoFacts = {
					region: cfg.region!,
					userPoolId: cfg.userPoolId!,
					userPoolClientId: cfg.userPoolClientId!,
					signInWith: ['email'],
				};
				const { outputs } = emitAmplifyOutputs(f);
				Amplify.configure(outputs);
				setFacts(f);
				setOutputsJson(JSON.stringify(outputs, null, 2));
			})
			.catch((e) => setLoadError(String(e)));
	}, []);

	const add = (s: Step) => setSteps((prev) => [...prev, s]);

	const run = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!facts) return;
		setBusy(true);
		setSteps([]);
		await signOut().catch(() => {});
		try {
			// 1. Stock default signIn() uses SRP, which the Blocks app client disables.
			try {
				await signIn({ username: email, password });
				add({ label: 'Default Amplify signIn() (SRP)', ok: false, detail: 'Accepted: this pool allows SRP' });
				await signOut();
			} catch (err) {
				add({ label: 'Default Amplify signIn() (SRP)', ok: null, detail: `Rejected as expected: ${(err as Error).message}` });
			}

			// 2. Same client, USER_PASSWORD_AUTH: the flow Blocks enables.
			const r = await signIn({ username: email, password, options: { authFlowType: 'USER_PASSWORD_AUTH' } });
			if (!r.isSignedIn) throw new Error(`sign-in stopped at ${r.nextStep.signInStep}`);
			const session = await fetchAuthSession();
			const iss = String(session.tokens?.idToken?.payload.iss ?? '');
			const want = `https://cognito-idp.${facts.region}.amazonaws.com/${facts.userPoolId}`;
			add({ label: 'Amplify signIn() with USER_PASSWORD_AUTH', ok: iss === want, detail: `ID token issuer ${iss}` });

			// 3. Does the Blocks API recognise an Amplify-signed-in user?
			const token = session.tokens?.accessToken.toString() ?? '';
			const withToken = await rpc('api.whoAmI', [], { authorization: `Bearer ${token}` });
			add({
				label: 'Blocks API with the Amplify token (no session cookie)',
				ok: null,
				detail: withToken.error ? `Refused: ${withToken.error.message} (Blocks accepts only its own session cookie)` : `Accepted: ${JSON.stringify(withToken.result)}`,
			});
			await signOut();

			// 4. Contrast: Blocks' own server-side sign-in (session cookie).
			const bff = await rpc('authApi.setAuthState', [{ action: 'signIn', username: email, password }]);
			const state = (bff.result as { state?: string } | undefined)?.state;
			const me = await rpc('api.whoAmI', []);
			add({
				label: 'Blocks sign-in (session cookie), then the Blocks API',
				ok: state === 'signedIn' && !me.error,
				detail: me.error ? `Refused: ${me.error.message}` : `whoAmI ${JSON.stringify(me.result)}`,
			});
			await rpc('authApi.setAuthState', [{ action: 'signOut' }]);
		} catch (err) {
			add({ label: 'Unexpected error', ok: false, detail: (err as Error).message });
		} finally {
			setBusy(false);
		}
	};

	return (
		<main style={{ maxWidth: 820, margin: '2rem auto', fontFamily: 'system-ui, sans-serif', lineHeight: 1.4 }}>
			<h1>Amplify sign-in on a Blocks backend</h1>
			<p>
				The stock <code>aws-amplify</code> Auth client, configured from an <code>amplify_outputs.json</code> generated
				from a Cognito pool that Blocks provisioned. No Amplify backend or CLI is involved.
			</p>
			{loadError && <p role="alert">Could not load config: {loadError}</p>}
			<form onSubmit={run} style={{ display: 'grid', gap: 8, maxWidth: 360 }}>
				<label>
					Email
					<input value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" style={{ display: 'block', width: '100%' }} />
				</label>
				<label>
					Password
					<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" style={{ display: 'block', width: '100%' }} />
				</label>
				<button type="submit" disabled={!facts || busy}>{busy ? 'Running…' : 'Run the sign-in demo'}</button>
			</form>
			{steps.length > 0 && (
				<ol aria-live="polite">
					{steps.map((s, i) => (
						<li key={i} style={{ marginTop: 8 }}>
							<strong>{s.ok === true ? 'PASS' : s.ok === false ? 'FAIL' : 'INFO'}</strong> {s.label}
							<div style={{ fontFamily: 'monospace', fontSize: 13, wordBreak: 'break-all' }}>{s.detail}</div>
						</li>
					))}
				</ol>
			)}
			<details style={{ marginTop: 24 }}>
				<summary>Generated amplify_outputs.json</summary>
				<pre style={{ fontSize: 12 }}>{outputsJson}</pre>
			</details>
		</main>
	);
}

createRoot(document.getElementById('root')!).render(<App />);
