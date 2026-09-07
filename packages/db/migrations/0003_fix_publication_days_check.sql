-- Fix the publication-calendar CHECK, which did not reject the empty array.
--
-- `array_length('{}'::smallint[], 1)` returns NULL, not 0, and a CHECK constraint
-- fails only on FALSE — never on NULL. So `array_length(...) >= 1` evaluated to NULL
-- for exactly the input it was written to forbid, and Postgres accepted it.
--
-- This is not a cosmetic bug. An empty calendar means `publicationDaysElapsed` finds
-- no day to count, freezing the series' age at zero: it would have read LIVE forever,
-- with full confidence weight, no matter how long the data had been missing. The one
-- failure mode the constraint existed to prevent was the one it let through.
--
-- `cardinality` returns 0 for an empty array, so the comparison is FALSE rather than
-- NULL and the constraint bites.
ALTER TABLE "macro_series"
  DROP CONSTRAINT IF EXISTS "macro_series_publication_days_valid";
--> statement-breakpoint

ALTER TABLE "macro_series"
  ADD CONSTRAINT "macro_series_publication_days_valid" CHECK (
    cardinality("expected_publication_days") >= 1
    AND "expected_publication_days" <@ ARRAY[0, 1, 2, 3, 4, 5, 6]::smallint[]
  );
