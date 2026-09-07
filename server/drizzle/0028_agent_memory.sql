CREATE TABLE agent_memory (
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  standing_instructions text NOT NULL DEFAULT '' CHECK (char_length(standing_instructions) <= 6000),
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 6000),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, agent_id)
);
