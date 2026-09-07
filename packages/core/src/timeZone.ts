/**
 * Civil dates and day boundaries in a named time zone.
 *
 * A report has to say which day it describes, and "which day" is a question about a
 * calendar, not about UTC. Every fact this system holds is anchored to US release and
 * market calendars — the 08:30 ET prints, the business-day freshness thresholds, the
 * economic calendar itself. Dating a report by the UTC boundary would file a run made at
 * 20:00 ET under tomorrow's date while its contents describe today, and the permanent
 * link would then disagree with the email that carried it.
 *
 * So the day boundary is configuration (`REPORT_TIMEZONE`), and it is resolved here
 * rather than by slicing an ISO string.
 *
 * Nothing here caches. `Intl.DateTimeFormat` construction is not free, but a wrong offset
 * cached across a DST transition is a class of bug that surfaces twice a year and is
 * unreproducible in between; the cost of getting it right is a few microseconds a day.
 */

/**
 * The real UTC offset of `timeZone` at `at`, in minutes.
 *
 * East of Greenwich is positive. The offset is read at a specific instant because it is
 * not a property of the zone — America/New_York is -300 in January and -240 in July, and
 * a function that took only a zone would have to pick one and be wrong half the year.
 *
 * @throws if the zone is not one this runtime knows, or its offset cannot be read.
 *   A silent fallback here would produce reports dated a day out with nothing to notice.
 */
export function zoneOffsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  }).formatToParts(at);

  const value = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
  // 'GMT-4', 'GMT-04:00' and bare 'GMT' (offset zero) are all valid renderings.
  const match = /^GMT(?:([+-])(\d{1,2})(?::?(\d{2}))?)?$/.exec(value);
  if (match === null) {
    throw new Error(
      `Cannot read the UTC offset of time zone '${timeZone}' (formatted as '${value}'). ` +
        'A report dated in the wrong zone is off by a day with nothing to signal it, ' +
        'so this fails rather than assuming an offset.',
    );
  }

  if (match[1] === undefined) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0));
}

/**
 * Reject a zone this runtime does not know, at configuration time.
 *
 * `Intl` silently falls back to the system zone for an unrecognised identifier in some
 * runtimes, which is exactly the failure this whole module exists to prevent: a typo in
 * an environment variable producing correct-looking reports dated in the wrong calendar.
 */
export function assertValidTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
  } catch {
    throw new Error(
      `'${timeZone}' is not a time zone this runtime recognises. ` +
        'Use an IANA identifier such as America/New_York or UTC.',
    );
  }
}

/** The civil date (`YYYY-MM-DD`) at instant `at`, as `timeZone` reckons it. */
export function civilDateIn(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);

  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const [year, month, day] = [get('year'), get('month'), get('day')];
  if (year === '' || month === '' || day === '') {
    throw new Error(`Cannot read a civil date in time zone '${timeZone}'.`);
  }
  return `${year}-${month}-${day}`;
}

export interface DayBounds {
  /** First instant of the civil day. */
  readonly start: Date;
  /** First instant of the following civil day — exclusive. */
  readonly end: Date;
}

/**
 * The UTC instants bounding civil day `date` in `timeZone`.
 *
 * Two passes, because the offset depends on the instant and the instant depends on the
 * offset. The first pass guesses using the offset at UTC midnight; the second corrects
 * using the offset actually in force at the guessed instant. That converges everywhere a
 * transition does not land within the day's own offset distance of midnight — true of
 * every US and European transition, which move the clock at 02:00 or 03:00 local.
 *
 * The bounds are half-open so that a day's queries tile the timeline without overlap: an
 * analysis at exactly midnight belongs to the day starting, not the day ending.
 */
export function zonedDayBounds(date: string, timeZone: string): DayBounds {
  return { start: zonedStartOfDay(date, timeZone), end: zonedStartOfDay(nextDay(date), timeZone) };
}

function zonedStartOfDay(date: string, timeZone: string): Date {
  const naive = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(naive)) throw new Error(`'${date}' is not a YYYY-MM-DD date.`);

  const firstGuess = naive - zoneOffsetMinutes(new Date(naive), timeZone) * 60_000;
  const corrected = naive - zoneOffsetMinutes(new Date(firstGuess), timeZone) * 60_000;
  return new Date(corrected);
}

function nextDay(date: string): string {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed)) throw new Error(`'${date}' is not a YYYY-MM-DD date.`);
  return new Date(parsed + 86_400_000).toISOString().slice(0, 10);
}
