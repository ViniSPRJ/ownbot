-- Cursor is a native ACP provider and must be accepted by persisted conversation choices.
ALTER TABLE acp_conversation_models
  DROP CONSTRAINT acp_conversation_models_provider_check;
--> statement-breakpoint
ALTER TABLE acp_conversation_models
  ADD CONSTRAINT acp_conversation_models_provider_check
  CHECK (provider IN ('codex', 'claude', 'grok', 'pi', 'cursor'));
