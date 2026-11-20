import { api } from 'hosting-ssr-cdk-blocks';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const posts = await api.listPosts();

  return (
    <main>
      <h2>Recent Posts</h2>
      <p data-testid="ssr-home-marker">Server-rendered blog posts</p>

      {posts.length === 0 ? (
        <p data-testid="no-posts" style={{ color: '#888', padding: '2rem 0' }}>
          No posts yet. Be the first to write something!
        </p>
      ) : (
        <div data-testid="post-list">
          {posts.map((post: any) => (
            <article key={post.id} data-testid="post-card" style={{ background: '#f9f9f9', border: '1px solid #eee', borderRadius: '8px', padding: '1rem', margin: '0.75rem 0' }}>
              <h3><a href={`/posts/${post.id}`}>{post.title}</a></h3>
              <p style={{ color: '#666' }}>{post.body.slice(0, 150)}{post.body.length > 150 ? '...' : ''}</p>
              <p style={{ fontSize: '0.85rem', color: '#999' }}>by {post.author} · {new Date(post.createdAt).toLocaleDateString()}</p>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
