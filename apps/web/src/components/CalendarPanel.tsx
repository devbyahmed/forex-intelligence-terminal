/**
 * Upcoming and recent releases.
 *
 * The forecast column is empty for nearly every past release, and that is a fact about
 * the sources rather than a rendering fault: historical consensus is a paid product at
 * every vendor, and the one free feed carrying it is a rolling one-week window
 * (LIMITS.md §6.9). A column of blank cells with no explanation is indistinguishable
 * from a broken join, so the reason is stated once at panel level.
 *
 * `null` is rendered as an em dash rather than `0`. Zero is a real forecast value.
 */

import type { CalendarView } from '@forex-agent/contracts';

export function CalendarPanel({ view }: { view: CalendarView }): React.ReactElement {
  return (
    <section className="panel calendar-panel" aria-labelledby="calendar-heading">
      <header className="panel-head">
        <h2 id="calendar-heading">Economic calendar</h2>
        <span className="hint">{view.range}</span>
      </header>

      {view.forecastGapNote === null ? null : (
        <p className="calendar-note">{view.forecastGapNote}</p>
      )}

      {view.entries.length === 0 ? (
        <p className="news-empty">No releases scheduled in this range.</p>
      ) : (
        <table className="calendar-table">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Event</th>
              <th scope="col">Impact</th>
              <th scope="col">Actual</th>
              <th scope="col">Forecast</th>
              <th scope="col">Previous</th>
            </tr>
          </thead>
          <tbody>
            {view.entries.map((entry) => (
              <tr key={entry.id} className={`impact-${entry.importance.toLowerCase()}`}>
                <td>{entry.scheduledAt.slice(0, 16).replace('T', ' ')}</td>
                <td>
                  <span className="cal-country">{entry.country}</span> {entry.eventName}
                </td>
                <td>{entry.importance}</td>
                {/* An em dash, never a zero — zero is a real reading. */}
                <td className="num">{entry.actual ?? '—'}</td>
                <td className="num">{entry.forecast ?? '—'}</td>
                <td className="num">{entry.previous ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
