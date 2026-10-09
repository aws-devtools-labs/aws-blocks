import type { Metadata, Viewport } from 'next';

export const metadata: Metadata = {
  title: 'Blocks + Next.js',
  description: 'Next.js App Router with Blocks backend',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'var(--bb-font-family, system-ui, sans-serif)', padding: '2rem', maxWidth: '800px', margin: '0 auto', background: 'var(--bb-color-bg, #fff)', color: 'var(--bb-color-text, #333)' }}>
        <header style={{ marginBottom: '2rem', borderBottom: '1px solid var(--bb-color-border, #eee)', paddingBottom: '1rem' }}>
          <h1 style={{ margin: 0 }}>Blocks + Next.js</h1>
          <p style={{ color: 'var(--bb-color-text-muted, #666)', margin: '0.5rem 0 0' }}>Server Components calling Blocks API</p>
        </header>
        {children}
      </body>
    </html>
  );
}
