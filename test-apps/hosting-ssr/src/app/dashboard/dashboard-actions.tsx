'use client';

import { api } from 'hosting-ssr-cdk-blocks';

export function DashboardActions({ postId }: { postId?: string }) {
  async function handleDelete() {
    if (!postId) return;
    try {
      await api.deletePost(postId);
      window.location.reload();
    } catch (e: any) {
      alert(`Delete failed: ${e.message}`);
    }
  }

  async function handleLogout() {
    try { await api.authSignOut(); } catch {}
    window.location.href = '/';
  }

  if (postId) {
    return <button data-testid="btn-delete" onClick={handleDelete} style={{ color: '#c00', cursor: 'pointer', border: '1px solid #c00', borderRadius: '4px', padding: '0.25rem 0.5rem', background: '#fff' }}>Delete</button>;
  }

  return (
    <div style={{ margin: '0.5rem 0' }}>
      <a href="/create" style={{ marginRight: '1rem' }}>✏️ Write New Post</a>
      <button id="btn-logout" onClick={handleLogout} style={{ cursor: 'pointer', padding: '0.25rem 0.5rem' }}>Log Out</button>
    </div>
  );
}
