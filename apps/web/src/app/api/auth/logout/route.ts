/**
 * POST /api/auth/logout
 *
 * Revokes server-side as well as clearing the cookie. Clearing only the cookie would
 * leave a valid token in existence — a session someone else holding the token could
 * still use, which is not what "log out" means.
 */

import { NextResponse } from 'next/server';
import { revokeSessionByToken } from '@forex-agent/auth';
import { cookies } from 'next/headers';
import { CSRF_COOKIE, SESSION_COOKIE, openDb } from '../../../../lib/session';
import { CSRF_REJECTION_MESSAGE, verifyCsrf } from '../../../../lib/csrf';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  // Logout is state-changing: a forged one is a denial of service, small but real.
  const csrf = await verifyCsrf(request);
  if (!csrf.ok) {
    return NextResponse.json({ error: CSRF_REJECTION_MESSAGE }, { status: 403 });
  }

  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;

  if (token !== undefined && token !== '') {
    const handle = openDb();
    try {
      await revokeSessionByToken(handle.db, token, new Date());
    } finally {
      await handle.close();
    }
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.delete(SESSION_COOKIE);
  response.cookies.delete(CSRF_COOKIE);
  return response;
}
