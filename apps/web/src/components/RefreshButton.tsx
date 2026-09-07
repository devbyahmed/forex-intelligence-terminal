'use client';

/**
 * On-demand refresh, with its price on the label.
 *
 * **A refresh spends a shared daily allowance.** Twelve Data gives 800 credits a day
 * on this plan; FRED throttles hard and returns no `Retry-After`. A button that
 * quietly consumes that is not a convenience — it is a way for a curious user at 10am
 * to break the scheduled run at 4pm, and the failure lands hours later on someone who
 * did nothing and points at the wrong cause.
 *
 * So the cost is shown **before** the click, not reported after it, and the button
 * refuses rather than trying and failing. Three consequences:
 *
 * - The label states what pressing it consumes, in the provider's own units.
 * - When it cannot be afforded the button is disabled and the reason names the
 *   provider, the shortfall and the reset time. "Try again later" would tell the user
 *   nothing they can act on.
 * - A reserve is held back for scheduled ingestion, and the panel says so — otherwise
 *   a user who can see 270 credits remaining and is refused anyway will reasonably
 *   conclude the number is lying.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { RefreshQuote } from '@forex-agent/contracts';
import { postWithCsrf } from '../lib/csrfClient';

export function RefreshButton({ quote }: { quote: RefreshQuote }): React.ReactElement {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    setPending(true);
    setError(null);

    const response = await postWithCsrf('/api/analysis/XAUUSD');

    if (response.ok) {
      router.refresh();
      setPending(false);
      return;
    }

    const body = (await response.json().catch(() => ({}))) as { error?: string };
    // The server re-checks the budget: this component's quote is a snapshot, and
    // another tab may have spent it between render and click.
    setError(body.error ?? 'The refresh could not be completed.');
    setPending(false);
  }

  return (
    <section className="panel refresh-panel" aria-labelledby="refresh-heading">
      <header className="panel-head">
        <h2 id="refresh-heading">Refresh</h2>
        <span className="hint">{quote.costSummary}</span>
      </header>

      <button
        type="button"
        onClick={() => void refresh()}
        disabled={pending || !quote.affordable}
        className="refresh-button"
      >
        {pending ? 'Refreshing…' : 'Fetch new data and re-run'}
      </button>

      {quote.affordable ? null : (
        <p className="refresh-refusal" role="status">
          {quote.refusal}
        </p>
      )}

      {error === null ? null : (
        <p className="refresh-refusal" role="alert">
          {error}
        </p>
      )}

      {/*
        The budget itself, not just the verdict. A user refused while 270 credits
        remain needs to see the reserve to understand why, or the refusal looks
        arbitrary and the number looks wrong.
      */}
      <table className="quota-table">
        <thead>
          <tr>
            <th scope="col">Provider</th>
            <th scope="col">This refresh</th>
            <th scope="col">Used today</th>
            <th scope="col">Held for scheduled runs</th>
          </tr>
        </thead>
        <tbody>
          {quote.providers.map((p) => (
            <tr key={p.providerId} className={p.affordable ? '' : 'quota-blocked'}>
              <td>{p.providerId}</td>
              <td className="num">
                {p.cost} {p.unit}
              </td>
              <td className="num">
                {p.dailyLimit === null
                  ? `${String(p.usedToday)} (no daily cap)`
                  : `${String(p.usedToday)} / ${String(p.dailyLimit)}`}
              </td>
              <td className="num">{p.reserved === 0 ? '—' : p.reserved}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
