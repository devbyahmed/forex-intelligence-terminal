/**
 * What the system itself is doing.
 *
 * A dashboard that reports on the market without reporting on its own health lets a
 * quiet ingestion failure look like a quiet market — the same confusion the abstention
 * model exists to prevent, one level up. Provider state, quota consumption and recent
 * job runs are all here, and warnings are listed first because they are the only part
 * that asks anything of the reader.
 */

import type { SystemStatus } from '@forex-agent/contracts';

export function SystemStatusPanel({ status }: { status: SystemStatus }): React.ReactElement {
  return (
    <section className="panel status-panel" aria-labelledby="status-heading">
      <header className="panel-head">
        <h2 id="status-heading">System status</h2>
        <span className="hint">Providers, quota and recent runs</span>
      </header>

      {status.warnings.length === 0 ? null : (
        <ul className="status-warnings">
          {status.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      <h3>Providers</h3>
      <table className="status-table">
        <thead>
          <tr>
            <th scope="col">Provider</th>
            <th scope="col">State</th>
            <th scope="col">Quota today</th>
            <th scope="col">Last success</th>
          </tr>
        </thead>
        <tbody>
          {status.providers.map((p) => (
            <tr key={p.providerId}>
              <td>
                {p.providerId} <span className="prov-meta">tier {p.tier}</span>
              </td>
              <td>
                <span className={`state state-${p.state.toLowerCase()}`}>{p.state}</span>
                {p.consecutiveFailures > 0 ? (
                  <span className="prov-meta"> {p.consecutiveFailures} consecutive failures</span>
                ) : null}
              </td>
              <td className="num">
                {p.quotaLimitDaily === null
                  ? `${String(p.quotaUsedToday)} (no daily cap)`
                  : `${String(p.quotaUsedToday)} / ${String(p.quotaLimitDaily)}`}
              </td>
              <td>{p.lastSuccessAt === null ? 'never' : p.lastSuccessAt.slice(0, 16).replace('T', ' ')}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Recent job runs</h3>
      <ul className="run-list">
        {status.recentRuns.map((r) => (
          <li key={`${r.jobName}-${r.startedAt}`}>
            <span className={`state state-${r.status.toLowerCase()}`}>{r.status}</span>
            <span className="run-name">{r.jobName}</span>
            <span className="prov-meta">
              {r.startedAt.slice(0, 16).replace('T', ' ')}
              {r.durationMs === null ? '' : ` · ${String(Math.round(r.durationMs / 1000))}s`}
            </span>
            {r.detail === null ? null : <p className="run-detail">{r.detail}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
