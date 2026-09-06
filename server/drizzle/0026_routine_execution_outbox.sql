-- Nullable occurrence preserves historical/manual firings without inventing timestamps.
ALTER TABLE routine_runs ADD COLUMN scheduled_for timestamptz,
  ADD COLUMN claimed_at timestamptz,
  ADD COLUMN instruction_snapshot text,
  ADD COLUMN channel_id_snapshot text,
  ADD COLUMN reply_text text,
  ADD COLUMN result_message_id text;
--> statement-breakpoint
CREATE UNIQUE INDEX routine_runs_occurrence_idx ON routine_runs (routine_id, scheduled_for);
--> statement-breakpoint
-- Legacy in-flight turns have unknown effects; never silently replay them on rollout.
UPDATE routine_runs SET claimed_at = started_at WHERE status IS NULL;
--> statement-breakpoint
CREATE TABLE routine_notifications (
  run_id text PRIMARY KEY REFERENCES routine_runs(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  delivered_at timestamptz,
  last_error text,
  receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX routine_notifications_due_idx ON routine_notifications(status, next_attempt_at);
-- Do not backfill historical terminal runs: their legacy delivery receipts are not authoritative.
-- Newly finished/recovered runs enter this ledger atomically with their outcome.
