'use client';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div style={{ padding: '2rem', textAlign: 'center' }}>
      <h2>Something went wrong</h2>
      <p style={{ color: '#666' }}>{error.message}</p>
      <button
        type="button"
        onClick={reset}
        style={{ padding: '0.5rem 1rem', marginTop: '1rem', cursor: 'pointer' }}
      >
        Try again
      </button>
    </div>
  );
}
