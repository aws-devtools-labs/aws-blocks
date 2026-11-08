'use client';

import { Component, startTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';

// error.tsx catches errors for the whole route, so one failing section would
// replace the entire page, including client components that still work. Wrap
// each independent section in a SectionBoundary to keep a failure inside it.
export function SectionBoundary({ children }: { children: ReactNode }) {
  const router = useRouter();
  // A Server Component error only clears once its data is fetched again, so
  // retry by refreshing the route before re-rendering the section.
  return <Boundary onRetry={() => router.refresh()}>{children}</Boundary>;
}

class Boundary extends Component<{ children: ReactNode; onRetry: () => void }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  retry = () => {
    startTransition(() => {
      this.props.onRetry();
      this.setState({ error: null });
    });
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" style={{ background: 'var(--bb-color-surface-alt, #f5f5f5)', padding: '1rem', borderRadius: 'var(--bb-radius-sm, 4px)' }}>
        <p style={{ margin: 0 }}>This section failed to load.</p>
        <p style={{ color: 'var(--bb-color-text-muted, #666)', margin: '0.5rem 0' }}>{this.state.error.message}</p>
        <button type="button" onClick={this.retry} className="bb-button">
          Try again
        </button>
      </div>
    );
  }
}
