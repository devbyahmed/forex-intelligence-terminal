'use client';

/**
 * Who you are signed in as, and how to stop being.
 *
 * A client component only because logout is a POST that must carry the session cookie
 * and then refresh the server-rendered page.
 */

import { useRouter } from 'next/navigation';
import { postWithCsrf } from '../lib/csrfClient';

export function SignedInBar({ email }: { email: string }): React.ReactElement {
  const router = useRouter();

  async function logout(): Promise<void> {
    await postWithCsrf('/api/auth/logout');
    router.push('/login');
    router.refresh();
  }

  return (
    <div className="signed-in">
      <span>Signed in as {email}</span>
      <button type="button" onClick={() => void logout()}>
        Sign out
      </button>
    </div>
  );
}
