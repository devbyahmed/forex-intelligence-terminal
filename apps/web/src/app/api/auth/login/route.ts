/**
 * POST /api/auth/login
 *
 * Delegates entirely to `packages/auth`, which owns rate limiting, lockout,
 * constant-time comparison and uniform timing. This route does three things it must
 * not get wrong: it never distinguishes an unknown account from a bad password, it
 * never logs the password, and it sets the session cookie only on success.
 */

import { NextResponse } from 'next/server';
import { login } from '@forex-agent/auth';
import { randomBytes } from 'node:crypto';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  csrfCookieOptions,
  openDb,
  sessionCookieOptions,
} from '../../../../lib/session';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const { email, password } = (body ?? {}) as { email?: unknown; password?: unknown };
  if (typeof email !== 'string' || typeof password !== 'string') {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const handle = openDb();
  try {
    const result = await login(handle.db, {
      email,
      password,
      ipAddress: request.headers.get('x-forwarded-for'),
      userAgent: request.headers.get('user-agent'),
      now: new Date(),
    });

    if (!result.ok) {
      // One message for every failure mode. Distinguishing them here would undo the
      // enumeration resistance the auth package goes to some trouble to provide.
      return NextResponse.json(
        { error: 'Those credentials were not accepted.' },
        { status: 401 },
      );
    }

    const response = NextResponse.json({ ok: true });
    response.cookies.set(
      SESSION_COOKIE,
      result.session.token,
      sessionCookieOptions(result.session.absoluteExpiresAt),
    );
    response.cookies.set(
      CSRF_COOKIE,
      randomBytes(32).toString('base64url'),
      csrfCookieOptions(result.session.absoluteExpiresAt),
    );
    return response;
  } finally {
    await handle.close();
  }
}
