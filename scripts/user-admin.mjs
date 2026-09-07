#!/usr/bin/env node
/**
 * User administration.
 *
 *   node scripts/user-admin.mjs create <email> [display name]
 *   node scripts/user-admin.mjs reset  <email>
 *   node scripts/user-admin.mjs list
 *   node scripts/user-admin.mjs deactivate <email>
 *   node scripts/user-admin.mjs activate   <email>
 *
 * There is no default credential and no way to pass a password as an argument:
 * a password on the command line lands in shell history and in the process table,
 * where any other user on the machine can read it. It is always prompted for, with
 * echo disabled.
 */

import { createInterface } from 'node:readline';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

function loadEnvFile() {
  const path = join(repoRoot, '.env');
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value !== '') out[m[1]] = value;
  }
  return out;
}

const env = { ...loadEnvFile(), ...process.env };
const connectionString = env.DATABASE_URL;

if (!connectionString) {
  console.error('DATABASE_URL is not set. See .env.example.');
  process.exit(1);
}

/** Read a line with echo suppressed, so the password never appears on screen. */
function promptHidden(question) {
  return new Promise((resolvePrompt, rejectPrompt) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const onData = (char) => {
      const s = String(char);
      if (s === '\n' || s === '\r' || s === '') {
        process.stdin.removeListener('data', onData);
      } else {
        // Repaint the prompt without the typed characters.
        process.stdout.write(`[2K\r${question}`);
      }
    };
    process.stdin.on('data', onData);
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolvePrompt(answer);
    });
    rl.on('error', rejectPrompt);
  });
}

async function promptNewPassword() {
  const first = await promptHidden('New password (min 12 chars): ');
  const second = await promptHidden('Confirm password: ');
  if (first !== second) {
    console.error('Passwords do not match.');
    process.exit(1);
  }
  return first;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) {
    console.error(
      'Usage:\n' +
        '  user-admin.mjs create <email> [display name]\n' +
        '  user-admin.mjs reset <email>\n' +
        '  user-admin.mjs list\n' +
        '  user-admin.mjs deactivate <email>\n' +
        '  user-admin.mjs activate <email>',
    );
    process.exit(1);
  }

  const { drizzle } = await import('drizzle-orm/node-postgres');
  const { eq, sql } = await import('drizzle-orm');
  const { users } = await import('../packages/db/dist/index.js');
  const auth = await import('../packages/auth/dist/index.js');

  const pool = new pg.Pool({ connectionString });
  const db = drizzle(pool, { schema: { users } });
  const now = new Date();

  const findByEmail = async (email) => {
    const [row] = await db
      .select({ id: users.id, email: users.email, isActive: users.isActive })
      .from(users)
      .where(sql`lower(${users.email}) = ${email.trim().toLowerCase()}`)
      .limit(1);
    return row;
  };

  try {
    switch (command) {
      case 'create': {
        const [email, ...nameParts] = rest;
        if (!email) throw new Error('An email address is required.');
        if (await findByEmail(email)) throw new Error(`${email} already exists.`);
        const password = await promptNewPassword();
        const id = await auth.createUser(db, {
          email,
          password,
          displayName: nameParts.join(' ') || null,
          now,
        });
        console.log(`Created ${email} (${id})`);
        break;
      }

      case 'reset': {
        const [email] = rest;
        if (!email) throw new Error('An email address is required.');
        const user = await findByEmail(email);
        if (!user) throw new Error(`No account for ${email}.`);
        const password = await promptNewPassword();
        const revoked = await auth.adminResetPassword(db, {
          userId: user.id,
          newPassword: password,
          now,
        });
        console.log(`Password reset for ${user.email}. Ended ${revoked} session(s).`);
        break;
      }

      case 'list': {
        const rows = await db
          .select({
            email: users.email,
            displayName: users.displayName,
            isActive: users.isActive,
            lastLoginAt: users.lastLoginAt,
          })
          .from(users);
        if (rows.length === 0) {
          console.log('No accounts. Create one with: user-admin.mjs create <email>');
          break;
        }
        for (const r of rows) {
          const status = r.isActive ? 'active' : 'INACTIVE';
          const last = r.lastLoginAt ? r.lastLoginAt.toISOString() : 'never';
          console.log(`${r.email}  [${status}]  last login: ${last}`);
        }
        break;
      }

      case 'deactivate':
      case 'activate': {
        const [email] = rest;
        if (!email) throw new Error('An email address is required.');
        const user = await findByEmail(email);
        if (!user) throw new Error(`No account for ${email}.`);
        const isActive = command === 'activate';
        await db.update(users).set({ isActive }).where(eq(users.id, user.id));
        if (!isActive) {
          // Deactivation must take effect immediately, not at the next expiry.
          await auth.revokeAllSessions(db, { userId: user.id, now });
        }
        console.log(`${user.email} is now ${isActive ? 'active' : 'inactive'}.`);
        break;
      }

      default:
        throw new Error(`Unknown command: ${command}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
