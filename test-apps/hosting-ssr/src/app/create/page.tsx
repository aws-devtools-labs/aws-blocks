'use client';

import { useState } from 'react';
import { api } from 'hosting-ssr-cdk-blocks';

export default function CreatePostPage() {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) { setError('Title is required'); return; }
    setError('');
    setLoading(true);
    try {
      await api.createPost(title, body);
      window.location.href = '/dashboard';
    } catch (err: any) {
      setError(err.message);
      setLoading(false);
    }
  }

  return (
    <main>
      <h2>Write a Post</h2>
      <form onSubmit={handleSubmit} style={{ maxWidth: '600px' }}>
        <div style={{ margin: '0.5rem 0' }}>
          <input id="post-title" value={title} onChange={e => setTitle(e.target.value)} placeholder="Post title" style={{ width: '100%', padding: '0.5rem', fontSize: '1.1rem' }} />
        </div>
        <div style={{ margin: '0.5rem 0' }}>
          <textarea id="post-body" value={body} onChange={e => setBody(e.target.value)} placeholder="Write your post..." rows={8} style={{ width: '100%', padding: '0.5rem', resize: 'vertical' }} />
        </div>
        {error && <p id="create-error" style={{ color: '#c00' }}>{error}</p>}
        <button id="btn-publish" type="submit" disabled={loading} style={{ padding: '0.5rem 1.5rem', background: '#0066cc', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
          {loading ? 'Publishing...' : 'Publish'}
        </button>
      </form>
    </main>
  );
}
