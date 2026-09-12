-- Per-conversation model selection for ACP coworkers.
--
-- Model selection used to exist in exactly one place: the operator's JSON file, per role. That is the
-- right place for a standing decision and the wrong place for a passing one. A person in Cowork picks a
-- model for the task in front of them, in this conversation, and expects the other conversations to stay as
-- they were. This is the second place.
--
-- The row records who chose, against which connection, and the operator configuration revision the choice
-- was validated against. The revision matters: the catalogue of models belongs to the CLI, and a choice
-- made against a catalogue the operator has since changed is a choice about a model that may no longer
-- exist. A stale revision is refused rather than honoured.
--
-- No prompt, no transcript, no credential. A selection is a fact about which model answered, and nothing
-- about what it was asked.
CREATE TABLE acp_conversation_models (
 thread_id text NOT NULL,
 agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
 owner_user_id text REFERENCES users(id) ON DELETE SET NULL,
 -- Which operator profile this conversation's session runs on. The model is only meaningful beside it:
 -- the same model id can exist on two connections and name two different things.
 profile_id text NOT NULL,
 provider text NOT NULL CHECK (provider IN ('codex','claude','grok','pi')),
 -- NULL means follow the operator's default for the profile. The row still exists, because "no choice"
 -- chosen on purpose is a different thing from never having asked.
 model text,
 -- The sha256 of the operator configuration this selection was validated against.
 operator_revision text NOT NULL,
 selected_by text REFERENCES users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (thread_id, agent_id)
);

-- Rosters ask "what has this person selected, where", which is the only question this table answers.
CREATE INDEX acp_conversation_models_owner ON acp_conversation_models(owner_user_id);
