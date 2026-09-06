CREATE TABLE IF NOT EXISTS openbot_service_health (
 name text PRIMARY KEY,
 last_ok_at timestamptz NOT NULL DEFAULT now()
);
