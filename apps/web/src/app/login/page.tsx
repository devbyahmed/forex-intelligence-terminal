'use client';

/**
 * The login form.
 *
 * A client component because it holds form state, but it holds nothing else: the
 * credential goes straight to the API route and the response carries only whether it
 * was accepted. No token, no user id, no hint about which half was wrong.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * What this handler actually uses from the submit event.
 *
 * React 19's types no longer export a standalone `FormEvent`, and naming the whole
 * synthetic event type would claim a dependency on more of it than this uses.
 */
interface SubmitEvent {
  preventDefault: () => void;
  readonly currentTarget: HTMLFormElement;
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);

    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    if (response.ok) {
      router.push('/');
      router.refresh();
      return;
    }

    const body = (await response.json().catch(() => ({}))) as { error?: string };
    setError(body.error ?? 'Those credentials were not accepted.');
    setPending(false);
  }

  return (
    <section className="panel login-panel">
      <h2>Sign in</h2>
      {/*
        `void` rather than an async handler: React does not await the returned
        promise, so an unhandled rejection would be swallowed rather than surfaced.
        The handler already catches its own errors into `setError`.
      */}
      <form
        onSubmit={(event) => {
          void onSubmit(event);
        }}
      >
        <label htmlFor="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => { setEmail(e.target.value); }}
        />

        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => { setPassword(e.target.value); }}
        />

        <button type="submit" disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </button>

        {/*
          One message for every failure. `role="alert"` so it is announced, and so the
          E2E test can assert on it without depending on styling.
        */}
        {error === null ? null : (
          <p className="login-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}
