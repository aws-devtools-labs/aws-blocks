import type { Metadata, Viewport } from 'next';
import { HydrationMarker } from './hydration-marker';

export const metadata: Metadata = {
  title: 'Blocks Blog',
  description: 'Next.js SSR blog for Blocks Hosting e2e tests',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: '800px', margin: '0 auto', color: '#333' }}>
        <header style={{ marginBottom: '2rem', borderBottom: '1px solid #eee', paddingBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <div>
            <h1 style={{ margin: 0 }}>
              <a href="/" style={{ textDecoration: 'none', color: 'inherit' }}>✍️ Blocks Blog</a>
              <span style={{ marginLeft: '0.5rem', fontSize: '0.75rem', padding: '0.15rem 0.5rem', borderRadius: '4px', background: '#000', color: '#fff', fontWeight: 'normal', verticalAlign: 'middle' }}>Next.js</span>
            </h1>
            <p style={{ color: '#666', margin: '0.25rem 0 0' }}>Next.js App Router · SSR Hosting E2E Test</p>
          </div>
          <nav style={{ display: 'flex', gap: '1rem' }}>
            <a href="/">Home</a>
            <a href="/dashboard">Dashboard</a>
            <a href="/profile">Profile</a>
            <a href="/create">Write</a>
            <a href="/api-test">API Test</a>
            <a href="/login">Login</a>
          </nav>
        </header>
        {children}
        <HydrationMarker />
      </body>
    </html>
  );
}
