import { api } from 'hosting-ssr-aws-blocks';
import { redirect } from 'next/navigation';
import { withAuth } from 'aws-cdk-blocks/server';

export const dynamic = 'force-dynamic';

export default async function ProfilePage() {
  let profile: any = null;

  try {
    profile = await withAuth(() => api.getProfile());
  } catch (error: any) {
    if (error?.status === 401 || error?.status === 403) {
      redirect('/login');
    }
    throw error;
  }

  if (!profile?.username) redirect('/login');

  return (
    <main>
      <h2>Profile</h2>
      <div data-testid="profile-card" style={{ background: '#f9f9f9', border: '1px solid #eee', borderRadius: '8px', padding: '1.5rem', maxWidth: '400px' }}>
        <p><strong>Username:</strong> <span data-testid="profile-username">{profile.username}</span></p>
        <p><strong>User ID:</strong> <span data-testid="profile-userid">{profile.userId}</span></p>
        <p><strong>Posts written:</strong> <span data-testid="profile-post-count">{profile.postCount}</span></p>
      </div>
      <p style={{ marginTop: '1rem' }}><a href="/dashboard">← Back to dashboard</a></p>
    </main>
  );
}
