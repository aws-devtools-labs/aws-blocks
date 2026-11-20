import { api } from 'hosting-ssr-aws-blocks';
import { redirect } from 'next/navigation';
import { withAuth } from 'aws-cdk-blocks/server';
import { DashboardActions } from './dashboard-actions';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  let posts: any[] = [];
  let username = '';

  try {
    const result = await withAuth(async () => {
      const myPosts = await api.listMyPosts();
      const profile = await api.getProfile();
      return { myPosts, profile };
    });
    posts = result.myPosts;
    username = result.profile.username || '';
  } catch (error: any) {
    if (error?.status === 401 || error?.status === 403) {
      redirect('/login');
    }
    throw error;
  }

  if (!username) redirect('/login');

  return (
    <main>
      <h2>My Dashboard</h2>
      <p data-testid="dashboard-user">Logged in as: <strong>{username}</strong></p>

      <DashboardActions />

      <h3>My Posts</h3>
      {posts.length === 0 ? (
        <p data-testid="no-posts" style={{ color: '#888' }}>No posts yet. <a href="/create">Write your first post!</a></p>
      ) : (
        <div data-testid="my-posts">
          {posts.map((post: any) => (
            <div key={post.id} data-testid="my-post-card" style={{ background: '#f9f9f9', border: '1px solid #eee', borderRadius: '8px', padding: '1rem', margin: '0.75rem 0', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <strong>{post.title}</strong>
                <p style={{ color: '#666', fontSize: '0.9rem' }}>{post.body.slice(0, 100)}</p>
              </div>
              <DashboardActions postId={post.id} />
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
