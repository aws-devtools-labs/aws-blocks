import { api } from 'hosting-ssr-cdk-blocks';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function PostPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const post = await api.getPost(id);

  if (!post) notFound();

  return (
    <main>
      <article>
        <h2 data-testid="post-title">{post.title}</h2>
        <p style={{ color: '#666', fontSize: '0.9rem' }} data-testid="post-meta">
          by {post.author} · {new Date(post.createdAt).toLocaleDateString()}
        </p>
        <div data-testid="post-body" style={{ marginTop: '1rem', lineHeight: 1.6 }}>
          {post.body}
        </div>
      </article>
      <p style={{ marginTop: '2rem' }}><a href="/">← Back to home</a></p>
    </main>
  );
}
