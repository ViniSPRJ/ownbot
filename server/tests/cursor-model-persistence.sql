-- Run with psql -v ON_ERROR_STOP=1 against a migrated database.
-- The temporary table copies the production CHECK constraints, never production data.
BEGIN;
CREATE TEMP TABLE cursor_model_probe (LIKE acp_conversation_models INCLUDING ALL);
INSERT INTO cursor_model_probe
  (thread_id, agent_id, profile_id, provider, model, operator_revision)
VALUES ('probe', 'news', 'cursor', 'cursor', 'auto', 'probe');
UPDATE cursor_model_probe SET model = NULL WHERE thread_id = 'probe';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cursor_model_probe WHERE provider = 'cursor' AND model IS NULL) THEN
    RAISE EXCEPTION 'Cursor preference did not persist';
  END IF;
  BEGIN
    UPDATE cursor_model_probe SET provider = 'unknown';
    RAISE EXCEPTION 'Unknown provider was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END $$;
ROLLBACK;
