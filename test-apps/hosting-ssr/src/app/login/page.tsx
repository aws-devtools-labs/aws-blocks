'use client';

import { useState } from 'react';
import { api } from 'hosting-ssr-aws-blocks';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);
  const [code, setCode] = useState('');

  async function handleSignUp() {
    setError('');
    try {
      await api.authSignUp(username, password);
      const codeInfo = await api.authGetLastCode(username);
      if (codeInfo) setCode(codeInfo.code);
      setShowConfirm(true);
      setInfo('Account created! Confirm with the verification code.');
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function handleConfirm() {
    setError('');
    try {
      await api.authConfirmSignUp(username, code);
      setShowConfirm(false);
      setInfo('Confirmed! You can now log in.');
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function handleLogin() {
    setError('');
    try {
      await api.authSignIn(username, password);
      window.location.href = '/dashboard';
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function handleLogout() {
    try { await api.authSignOut(); } catch {}
    window.location.href = '/';
  }

  return (
    <main>
      <h2>Login</h2>
      <div style={{ maxWidth: '400px' }}>
        <div style={{ margin: '0.5rem 0' }}>
          <input id="login-username" value={username} onChange={e => setUsername(e.target.value)} placeholder="Email" style={{ width: '100%', padding: '0.5rem' }} />
        </div>
        <div style={{ margin: '0.5rem 0' }}>
          <input id="login-password" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password" style={{ width: '100%', padding: '0.5rem' }} />
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', margin: '0.5rem 0' }}>
          <button id="btn-login" onClick={handleLogin} style={{ padding: '0.5rem 1rem' }}>Log In</button>
          <button id="btn-signup" onClick={handleSignUp} style={{ padding: '0.5rem 1rem' }}>Sign Up</button>
          <button id="btn-logout" onClick={handleLogout} style={{ padding: '0.5rem 1rem' }}>Log Out</button>
        </div>

        {showConfirm && (
          <div id="confirm-section" style={{ margin: '0.5rem 0', padding: '0.5rem', background: '#f0f0f0', borderRadius: '4px' }}>
            <input id="confirm-code" value={code} onChange={e => setCode(e.target.value)} placeholder="Verification code" style={{ width: '100%', padding: '0.5rem', marginBottom: '0.5rem' }} />
            <button id="btn-confirm" onClick={handleConfirm} style={{ padding: '0.5rem 1rem' }}>Confirm</button>
          </div>
        )}

        {error && <p id="auth-error" style={{ color: '#c00', margin: '0.5rem 0' }}>{error}</p>}
        {info && <p id="auth-info" style={{ color: '#666', margin: '0.5rem 0' }}>{info}</p>}
      </div>
    </main>
  );
}
