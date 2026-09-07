/**
 * No real email address appears in the repository.
 *
 * **This repository is public.** An address written into source, a test, or a document
 * is published to `github.com/devbyahmed/forex-intelligence-terminal`, indexed, and
 * scraped — and the people most likely to end up there are colleagues who never opted
 * into this project.
 *
 * That has already happened once in this codebase, in two different shapes: a real
 * address in a blocklist constant, and the same address again in the test that proved
 * the blocklist worked. The second is the instructive one — a test file is exactly
 * where such a thing survives a cleanup of the source, because cleanups look at source.
 *
 * So it is a test rather than a convention. Real addresses live in `.env`, which is
 * gitignored; everything committed uses a domain that can never be registered.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');

/**
 * Domains that can never belong to a real person.
 *
 * `.invalid`, `.example`, `.test` and `.localhost` are reserved by RFC 2606 and RFC
 * 6761 and are guaranteed never to resolve. `example.com`/`.net`/`.org` are reserved by
 * RFC 2606 for documentation. `resend.dev` is a vendor sandbox sender, not a mailbox.
 */
const SAFE_DOMAIN = /(?:\.(?:invalid|example|test|localhost)|^example\.(?:com|net|org)|^resend\.dev)$/;

/** Files that may legitimately mention an address: none, but the list is explicit. */
const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.md', '.mjs', '.json', '.yml', '.yaml', '.css'];

const SKIP_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  '.next',
  '.git',
  'test-results',
  'playwright-report',
]);

/** Every committed file worth scanning. `.env` is excluded: it is gitignored. */
function scannedFiles(): readonly string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRECTORIES.has(entry)) continue;
      // Never read the environment file: it holds the real values on purpose.
      if (entry.startsWith('.env')) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (SCANNED_EXTENSIONS.some((ext) => entry.endsWith(ext))) out.push(full);
    }
  };
  walk(REPO_ROOT);
  return out;
}

/**
 * Addresses in a file, ignoring the things that merely look like one.
 *
 * npm scopes (`@forex-agent/db`), decorators and email-shaped type names would
 * otherwise flood the result and train whoever reads it to skim.
 */
function addressesIn(source: string): readonly string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
    const address = match[0];
    // `user@host` inside a connection string is a credential, not a mailbox, and those
    // live only in .env — but a placeholder one may appear in a doc example.
    if (/^(?:user|username|postgres|neondb_owner)@/i.test(address)) continue;
    found.add(address);
  }
  return [...found];
}

describe('no real email address is committed', () => {
  it('scans a meaningful number of files', () => {
    // If the walk broke, every assertion below would pass by finding nothing.
    expect(scannedFiles().length).toBeGreaterThan(50);
  });

  it('finds only reserved placeholder domains', () => {
    const offenders: string[] = [];

    for (const file of scannedFiles()) {
      const source = readFileSync(file, 'utf8');
      for (const address of addressesIn(source)) {
        const domain = address.slice(address.lastIndexOf('@') + 1).toLowerCase();
        if (SAFE_DOMAIN.test(domain)) continue;
        offenders.push(`${relative(REPO_ROOT, file).replace(/\\/g, '/')} → ${address}`);
      }
    }

    /*
     * If this fails, replace the address with one on a reserved domain
     * (`someone@example.invalid`). Real values belong in `.env`, and behaviour that
     * depends on a specific address should take it as configuration — every guard in
     * this package already does.
     */
    expect(offenders).toEqual([]);
  });
});
