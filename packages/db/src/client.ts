/**
 * Database client with two drivers behind one interface.
 *
 * The primary deployment target is Neon, reached over **WebSockets** rather than
 * HTTP. The HTTP driver cannot do interactive transactions, and this system requires
 * them: the three-layer lineage writes and each analysis snapshot must commit
 * atomically or not at all. Local development and the always-on VM profile use
 * plain `node-postgres`.
 *
 * The schema and every query are identical across both. Only this file differs, and
 * driver selection is inferred from the connection string so no caller has to care.
 */

import { drizzle as drizzleNeon } from 'drizzle-orm/neon-serverless';
import { drizzle as drizzlePg, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool as NeonPool, neonConfig } from '@neondatabase/serverless';
import { Pool as PgPool } from 'pg';
import ws from 'ws';
import * as schema from './schema/index.js';

export type Schema = typeof schema;
export type Database = NodePgDatabase<Schema>;

/** The transaction handle passed to `db.transaction(...)` callbacks. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export type DriverKind = 'pg' | 'neon';

export interface DbOptions {
  readonly connectionString: string;
  /** Inferred from the host when omitted. */
  readonly driver?: DriverKind;
  /** Ignored by the Neon driver, which manages its own connections. */
  readonly maxConnections?: number;
  readonly connectionTimeoutMs?: number;
}

/**
 * Neon hostnames are recognisable, and getting this wrong is a silent failure — the
 * pg driver against Neon works until it doesn't, under connection pressure.
 */
export function inferDriver(connectionString: string): DriverKind {
  try {
    const { hostname } = new URL(connectionString);
    return hostname.endsWith('.neon.tech') || hostname.includes('neon.') ? 'neon' : 'pg';
  } catch {
    return 'pg';
  }
}

export interface DbHandle {
  readonly db: Database;
  readonly driver: DriverKind;
  /** Closes the underlying pool. Call on shutdown and between test files. */
  close(): Promise<void>;
}

let wsConfigured = false;

function configureNeonWebSockets(): void {
  if (wsConfigured) return;
  // Node has no global WebSocket in every supported version; the Neon driver needs
  // one to open a session that can hold a transaction.
  neonConfig.webSocketConstructor = ws;
  wsConfigured = true;
}

export function createDb(options: DbOptions): DbHandle {
  const driver = options.driver ?? inferDriver(options.connectionString);

  if (driver === 'neon') {
    configureNeonWebSockets();
    const pool = new NeonPool({ connectionString: options.connectionString });
    return {
      db: drizzleNeon(pool, { schema }),
      driver,
      close: async () => {
        await pool.end();
      },
    };
  }

  const pool = new PgPool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 10_000,
  });
  return {
    db: drizzlePg(pool, { schema }),
    driver,
    close: async () => {
      await pool.end();
    },
  };
}

export { schema };
