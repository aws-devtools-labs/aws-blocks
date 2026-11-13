'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from 'aws-blocks';
import { injectTheme } from '@aws-blocks/blocks/theme';
import { StatusMessage, type StatusMessageHandle } from '@aws-blocks/blocks/ui';

injectTheme();

// Client Component — runs in the browser
export function ClientGreeting() {
  const [name, setName] = useState('');
  const [greeting, setGreeting] = useState<{ message: string; timestamp: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const statusRef = useRef<HTMLDivElement>(null);
  const status = useRef<StatusMessageHandle | null>(null);

  // Client Components also render on the server, where there is no `document`,
  // so the status element is created in an effect. It lives outside React's
  // render output so re-renders never remount the live region — a region that
  // stays mounted is what screen readers announce.
  useEffect(() => {
    const handle = StatusMessage({ testId: 'greet-status' });
    statusRef.current?.appendChild(handle.element);
    status.current = handle;
    return () => {
      handle.element.remove();
      status.current = null;
    };
  }, []);

  async function handleGreet() {
    if (!name.trim()) return;
    setLoading(true);
    try {
      // Blocks client auto-discovers the API URL from config.json
      const result = await api.greet(name);
      setGreeting(result);
      status.current?.set('idle');
    } catch (e) {
      setGreeting(null);
      status.current?.set('error', `Could not greet: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ background: 'var(--bb-color-surface-alt, #f5f5f5)', padding: '1rem', borderRadius: 'var(--bb-radius-sm, 4px)' }}>
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleGreet()}
          placeholder="Enter your name"
          className="bb-input"
          style={{ flex: 1 }}
        />
        <button type="button" onClick={handleGreet} disabled={loading} className="bb-button bb-button-primary">
          {loading ? '...' : 'Greet'}
        </button>
      </div>
      <div ref={statusRef} />
      {greeting && (
        <pre style={{ margin: 0 }}>
          {JSON.stringify(greeting, null, 2)}
        </pre>
      )}
    </div>
  );
}
