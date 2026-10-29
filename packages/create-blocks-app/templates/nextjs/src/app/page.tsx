import { Suspense } from 'react';
import { api } from 'aws-blocks';
import { ClientGreeting } from './client';
import { SectionBoundary } from './section-boundary';

// Opt out of static prerendering — the Blocks API URL is only available at
// request time (Lambda env vars), not at build time during `cdk deploy`.
export const dynamic = 'force-dynamic';

// Async Server Component that fetches data
async function ServerTime() {
  const serverTime = await api.getServerTime();
  
  return (
    <pre style={{ background: 'var(--bb-color-surface-alt, #f5f5f5)', color: 'var(--bb-color-text, #333)', padding: '1rem', borderRadius: '4px' }}>
      {JSON.stringify(serverTime, null, 2)}
    </pre>
  );
}

// Loading fallback for Suspense
function ServerTimeLoading() {
  return (
    <pre style={{ background: 'var(--bb-color-surface-alt, #f5f5f5)', padding: '1rem', borderRadius: '4px', color: 'var(--bb-color-text-muted, #888)' }}>
      Loading server time...
    </pre>
  );
}

export default function Home() {
  return (
    <main>
      <section style={{ marginBottom: '2rem' }}>
        <h2>Server Component with Suspense</h2>
        <p>This data is fetched on the server with streaming:</p>
        <SectionBoundary>
          <Suspense fallback={<ServerTimeLoading />}>
            <ServerTime />
          </Suspense>
        </SectionBoundary>
      </section>

      <section>
        <h2>Client Component</h2>
        <p>This component runs in the browser and calls the Blocks API:</p>
        <SectionBoundary>
          <ClientGreeting />
        </SectionBoundary>
      </section>
    </main>
  );
}
