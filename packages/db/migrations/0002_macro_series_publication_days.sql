-- Publication calendars for macro series.
--
-- Freshness measured in calendar hours has a systematic weekend bias: the Friday
-- yield read on a Sunday is 40 hours old by the clock and drops out of LIVE, but it
-- is the latest figure in existence — nothing published because nothing was due.
-- Two days in seven of degraded confidence on every market-hours series is a
-- persistent distortion, and confidence carries the product's central claim.
--
-- Values are measured, not assumed: FRED first-release dates read on 2026-08-30.
-- Mon–Fri is the default because nine of the twelve series publish on business days.
ALTER TABLE "macro_series"
  ADD COLUMN "expected_publication_days" smallint[] NOT NULL DEFAULT '{1,2,3,4,5}'::smallint[];
--> statement-breakpoint

-- 0 = Sunday .. 6 = Saturday, and never empty: a series that publishes on no day at
-- all would freeze its own age at zero and read LIVE forever, which is the silent
-- failure mode, so it is rejected here rather than in the application alone.
--
-- Duplicate-freedom is NOT enforced here. Postgres CHECK constraints cannot contain
-- subqueries or aggregates, and there is no subquery-free way to express "no repeats"
-- over an array. It is enforced in `assertValidPublicationDays`, where a repeated day
-- is a code defect rather than a data-integrity problem — `publicationDaysElapsed`
-- reads the array into a Set, so a duplicate changes no result.
ALTER TABLE "macro_series"
  ADD CONSTRAINT "macro_series_publication_days_valid" CHECK (
    array_length("expected_publication_days", 1) >= 1
    AND "expected_publication_days" <@ ARRAY[0, 1, 2, 3, 4, 5, 6]::smallint[]
  );
--> statement-breakpoint

-- DTWEXBGS releases in a Monday batch (75 of 80 observed releases, median lag 5
-- days). It is a daily series with a weekly publication, and freshness is a question
-- about publication.
UPDATE "macro_series" SET "expected_publication_days" = '{1}'::smallint[]
  WHERE "series_id" = 'DTWEXBGS';
--> statement-breakpoint

-- ICSA releases on Thursdays (48 of 51), always describing the week ending the prior
-- Saturday.
UPDATE "macro_series" SET "expected_publication_days" = '{4}'::smallint[]
  WHERE "series_id" = 'ICSA';
