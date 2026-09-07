-- The inbox is a local, durable record, independent of external delivery.
CREATE TABLE user_notifications (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id text NOT NULL UNIQUE,
  title text NOT NULL,
  summary text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);
CREATE INDEX user_notifications_owner_created ON user_notifications(owner_user_id, created_at DESC, id DESC);
CREATE INDEX user_notifications_owner_unread ON user_notifications(owner_user_id) WHERE read_at IS NULL;
--> statement-breakpoint
CREATE FUNCTION record_routine_inbox_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('succeeded','failed','skipped') AND NEW.finished_at IS NOT NULL THEN
    INSERT INTO user_notifications(id,owner_user_id,run_id,title,summary,status,created_at)
    SELECT 'routine:' || NEW.id, r.owner_user_id, NEW.id,
      CASE NEW.status WHEN 'succeeded' THEN 'Rotina concluída' WHEN 'failed' THEN 'Falha na rotina' ELSE 'Rotina não concluída' END || ' · ' || r.agent_id,
      left(coalesce(nullif(NEW.reply_text,''),nullif(NEW.error,''), 'Consulte os detalhes da execução.'),2400),
      NEW.status,NEW.finished_at
    FROM routines r WHERE r.id=NEW.routine_id
    ON CONFLICT (run_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER routine_run_inbox AFTER INSERT OR UPDATE OF status,finished_at ON routine_runs
FOR EACH ROW EXECUTE FUNCTION record_routine_inbox_notification();
--> statement-breakpoint
INSERT INTO user_notifications(id,owner_user_id,run_id,title,summary,status,created_at)
SELECT 'routine:' || rr.id,r.owner_user_id,rr.id,
  CASE rr.status WHEN 'succeeded' THEN 'Rotina concluída' WHEN 'failed' THEN 'Falha na rotina' ELSE 'Rotina não concluída' END || ' · ' || r.agent_id,
  left(coalesce(nullif(rr.reply_text,''),nullif(rr.error,''),'Consulte os detalhes da execução.'),2400),rr.status,rr.finished_at
FROM routine_runs rr JOIN routines r ON r.id=rr.routine_id
WHERE rr.status IN ('succeeded','failed','skipped') AND rr.finished_at IS NOT NULL
ON CONFLICT (run_id) DO NOTHING;
--> statement-breakpoint
-- Persist the no-egress decision across process restarts or missing environment files.
CREATE TABLE outbound_notification_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  mode text NOT NULL DEFAULT 'telegram' CHECK (mode IN ('internal','telegram'))
);
INSERT INTO outbound_notification_policy(singleton,mode) VALUES (true,'telegram');
--> statement-breakpoint
CREATE FUNCTION gate_external_routine_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM outbound_notification_policy WHERE singleton AND mode='internal') THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER gate_external_notification BEFORE INSERT ON routine_notifications
FOR EACH ROW EXECUTE FUNCTION gate_external_routine_notification();
--> statement-breakpoint
CREATE FUNCTION suppress_external_notification_backlog() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.mode='internal' THEN
    UPDATE routine_notifications SET status='failed',lease_until=NULL,
      last_error='Suppressed: notifications are internal only'
    WHERE status IN ('pending','sending');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER suppress_external_backlog AFTER INSERT OR UPDATE OF mode ON outbound_notification_policy
FOR EACH ROW EXECUTE FUNCTION suppress_external_notification_backlog();
