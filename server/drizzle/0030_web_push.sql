CREATE TABLE push_subscriptions (
 id text PRIMARY KEY,
 owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 endpoint_hash text NOT NULL UNIQUE,
 encrypted_subscription text NOT NULL,
 vapid_public_key text NOT NULL,
 enabled boolean NOT NULL DEFAULT true,
 generation integer NOT NULL DEFAULT 1,
 opted_in_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX push_subscriptions_owner ON push_subscriptions(owner_user_id);
--> statement-breakpoint
CREATE TABLE push_outbox (
 notification_id text NOT NULL REFERENCES user_notifications(id) ON DELETE CASCADE,
 subscription_id text NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
 generation integer NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','cancelled','dead')),
 attempts integer NOT NULL DEFAULT 0,
 available_at timestamptz NOT NULL DEFAULT now(),
 lease_token text,
 lease_until timestamptz,
 last_error text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 delivered_at timestamptz,
 PRIMARY KEY(notification_id,subscription_id)
);
CREATE INDEX push_outbox_due ON push_outbox(available_at) WHERE status='pending';
--> statement-breakpoint
CREATE FUNCTION enqueue_inbox_web_push() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO push_outbox(notification_id,subscription_id,generation)
 SELECT NEW.id,s.id,s.generation FROM push_subscriptions s
 WHERE s.owner_user_id=NEW.owner_user_id AND s.enabled AND NEW.created_at>=s.opted_in_at
 ON CONFLICT DO NOTHING;
 RETURN NEW;
END;
$$;
CREATE TRIGGER inbox_web_push AFTER INSERT ON user_notifications
FOR EACH ROW EXECUTE FUNCTION enqueue_inbox_web_push();
