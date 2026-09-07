-- Amendment A2: lineage integrity for analysis_statements.
--
-- The CHECK constraints generated from the schema already guarantee the *shape* of
-- each row: a FACT carries provenance and no parents, a derived statement carries at
-- least one parent, an AI_ASSESSMENT names its generation. What a CHECK cannot do is
-- look at other rows — so it cannot verify that the parents actually exist, belong to
-- the same analysis, or sit at a lower layer.
--
-- Without that, `derived_from` could point at a statement in someone else's analysis,
-- at a sibling on the same layer, or at nothing at all, and the lineage would still
-- pass every constraint while being meaningless. This trigger closes that gap, which
-- is what makes the three-layer separation a structural guarantee rather than a
-- convention the writing code is trusted to honour.

CREATE OR REPLACE FUNCTION check_statement_lineage() RETURNS trigger AS $$
DECLARE
  parent_id        uuid;
  parent_layer     statement_layer;
  parent_analysis  uuid;
  own_rank         integer;
  parent_rank      integer;
BEGIN
  IF cardinality(NEW.derived_from) = 0 THEN
    RETURN NEW;
  END IF;

  own_rank := CASE NEW.layer
    WHEN 'FACT' THEN 0
    WHEN 'INTERPRETATION' THEN 1
    WHEN 'AI_ASSESSMENT' THEN 2
  END;

  FOREACH parent_id IN ARRAY NEW.derived_from LOOP
    SELECT layer, analysis_id
      INTO parent_layer, parent_analysis
      FROM analysis_statements
     WHERE id = parent_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'analysis_statements.derived_from references statement % which does not exist',
        parent_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- Lineage must stay inside one analysis; citing another analysis's facts would
    -- let a conclusion rest on evidence the reader is not shown.
    IF parent_analysis <> NEW.analysis_id THEN
      RAISE EXCEPTION
        'analysis_statements lineage crosses analyses: statement % belongs to analysis %, not %',
        parent_id, parent_analysis, NEW.analysis_id
        USING ERRCODE = 'check_violation';
    END IF;

    parent_rank := CASE parent_layer
      WHEN 'FACT' THEN 0
      WHEN 'INTERPRETATION' THEN 1
      WHEN 'AI_ASSESSMENT' THEN 2
    END;

    -- Strictly lower, not merely different: this is what makes the graph acyclic and
    -- guarantees every chain terminates at a provenanced fact.
    IF parent_rank >= own_rank THEN
      RAISE EXCEPTION
        'analysis_statements lineage must descend: % may not derive from % (statement %)',
        NEW.layer, parent_layer, parent_id
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER analysis_statements_lineage_check
  BEFORE INSERT OR UPDATE ON analysis_statements
  FOR EACH ROW EXECUTE FUNCTION check_statement_lineage();

-- Keep updated_at honest without every writer having to remember it.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.table_name
      FROM information_schema.columns c
     WHERE c.table_schema = 'public'
       AND c.column_name = 'updated_at'
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      t || '_set_updated_at', t
    );
  END LOOP;
END;
$$;
