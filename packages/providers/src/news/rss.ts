/**
 * RSS and Atom parsing.
 *
 * Hand-rolled rather than pulled from a library, for one reason: this parser must be
 * **loud when it yields nothing**. Most RSS libraries return an empty array for a feed
 * they cannot understand, which is indistinguishable from a genuinely quiet feed —
 * and that is exactly how four Fed feeds silently parsed as zero during the Phase 6
 * volume measurement. A `[^<]+` pattern cannot cross the `<![CDATA[` opener, so every
 * date came back unparseable and nothing anywhere reported a problem.
 *
 * Every extraction here handles CDATA, and `parseFeed` reports how many items it saw
 * versus how many it could use.
 */

import type { SourceTier } from '@forex-agent/core';

export interface ParsedItem {
  readonly title: string;
  readonly link: string;
  readonly summary: string | null;
  readonly publishedAt: Date;
  readonly guid: string | null;
}

export interface FeedParseResult {
  readonly items: readonly ParsedItem[];
  /** Raw `<item>` / `<entry>` blocks found, before validation. */
  readonly itemsSeen: number;
  /** Items dropped, with the reason — so a silent zero is never silent. */
  readonly dropped: readonly { reason: string; sample: string }[];
  readonly format: 'rss' | 'atom' | 'unknown';
}

export class FeedParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedParseError';
  }
}

/**
 * Extract the text of the first matching tag, handling CDATA.
 *
 * The `(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?` sandwich is the whole point: `[\s\S]*?`
 * crosses newlines and `<` where `[^<]+` stops dead at the CDATA opener.
 */
function tagText(block: string, ...names: readonly string[]): string | null {
  for (const name of names) {
    const re = new RegExp(
      `<${name}(?:\\s[^>]*)?>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`,
      'i',
    );
    const m = re.exec(block);
    if (m?.[1] !== undefined) {
      const text = decodeEntities(m[1]).trim();
      if (text !== '') return text;
    }
  }
  return null;
}

/** Atom links live in an attribute rather than in element text. */
function atomLink(block: string): string | null {
  const alternate = /<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i.exec(block);
  if (alternate?.[1] !== undefined) return decodeEntities(alternate[1]);
  const plain = /<link[^>]*href=["']([^"']+)["']/i.exec(block);
  return plain?.[1] === undefined ? null : decodeEntities(plain[1]);
}

const ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&nbsp;': ' ',
};

export function decodeEntities(text: string): string {
  return text
    .replace(/&(?:amp|lt|gt|quot|apos|#39|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}

/** Strip markup from a description that contains embedded HTML. */
export function stripHtml(text: string): string {
  return decodeEntities(text.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse a feed body.
 *
 * Throws when the body is not a feed at all — a 200 carrying an HTML error page or a
 * bot challenge must not be mistaken for an empty feed.
 */
export function parseFeed(xml: string): FeedParseResult {
  const trimmed = xml.trim();

  if (trimmed === '') throw new FeedParseError('Feed body was empty');
  if (/^\s*<!DOCTYPE html/i.test(trimmed) || /^\s*<html/i.test(trimmed)) {
    // A bot challenge or error page. Returning zero items here would look exactly
    // like a quiet feed.
    throw new FeedParseError('Feed body is HTML, not a feed — likely an error or bot challenge page');
  }

  const isAtom = /<feed[\s>]/i.test(trimmed);
  const format: FeedParseResult['format'] = isAtom
    ? 'atom'
    : /<rss[\s>]|<rdf:RDF[\s>]/i.test(trimmed)
      ? 'rss'
      : 'unknown';

  const blockRe = isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi;
  const blocks = trimmed.match(blockRe) ?? [];

  if (blocks.length === 0 && format === 'unknown') {
    throw new FeedParseError('Body is neither RSS nor Atom and contains no items');
  }

  const items: ParsedItem[] = [];
  const dropped: { reason: string; sample: string }[] = [];

  for (const block of blocks) {
    const title = tagText(block, 'title');
    const link = isAtom ? atomLink(block) : tagText(block, 'link', 'guid');
    const rawDate = tagText(block, 'pubDate', 'dc:date', 'published', 'updated');
    const rawSummary = tagText(block, 'description', 'summary', 'content:encoded', 'content');

    if (title === null) {
      dropped.push({ reason: 'no title', sample: block.slice(0, 80) });
      continue;
    }
    if (link === null) {
      dropped.push({ reason: 'no link', sample: title.slice(0, 80) });
      continue;
    }
    if (rawDate === null) {
      // The CDATA failure would land here — loudly, with the title named.
      dropped.push({ reason: 'no parseable date element', sample: title.slice(0, 80) });
      continue;
    }

    const ms = Date.parse(rawDate);
    if (Number.isNaN(ms)) {
      dropped.push({ reason: `unparseable date "${rawDate.slice(0, 40)}"`, sample: title.slice(0, 80) });
      continue;
    }

    items.push({
      title,
      link,
      summary: rawSummary === null ? null : stripHtml(rawSummary).slice(0, 1000),
      publishedAt: new Date(ms),
      guid: tagText(block, 'guid', 'id'),
    });
  }

  return { items, itemsSeen: blocks.length, dropped, format };
}

/**
 * Assert a feed actually yielded usable items.
 *
 * A feed returning 200 and parsing to zero is a bug, not a quiet day — the same
 * failure class as a join that matches nothing. Silence here would mean the news
 * pipeline reports success while ingesting nothing.
 */
export function assertParseYield(
  feedName: string,
  result: FeedParseResult,
  minYieldRate = 0.5,
): void {
  if (result.itemsSeen === 0) {
    throw new FeedParseError(
      `${feedName}: feed responded but contains no <item>/<entry> blocks. ` +
        `Format detected: ${result.format}.`,
    );
  }

  const yieldRate = result.items.length / result.itemsSeen;
  if (result.items.length === 0) {
    const reasons = [...new Set(result.dropped.map((d) => d.reason))].slice(0, 3).join('; ');
    throw new FeedParseError(
      `${feedName}: found ${String(result.itemsSeen)} items but parsed none. Reasons: ${reasons}. ` +
        `Examples: ${result.dropped.slice(0, 2).map((d) => d.sample).join(' | ')}`,
    );
  }
  if (yieldRate < minYieldRate) {
    const reasons = [...new Set(result.dropped.map((d) => d.reason))].slice(0, 3).join('; ');
    throw new FeedParseError(
      `${feedName}: only ${String(result.items.length)}/${String(result.itemsSeen)} items parsed ` +
        `(${(yieldRate * 100).toFixed(0)}%, below ${String(minYieldRate * 100)}%). Reasons: ${reasons}`,
    );
  }
}

export interface FeedDescriptor {
  readonly name: string;
  readonly url: string;
  readonly tier: SourceTier;
  readonly publisher: string | null;
}
