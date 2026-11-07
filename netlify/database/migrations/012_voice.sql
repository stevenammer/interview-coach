ALTER TABLE model_jobs DROP CONSTRAINT model_jobs_kind_check;
ALTER TABLE workspaces ADD COLUMN role_title text;
ALTER TABLE workspaces ADD COLUMN company_name text;
ALTER TABLE model_jobs ADD CONSTRAINT model_jobs_kind_check CHECK (kind IN
  ('paste','ingest','rep_extract','debrief','workspace_map','immerse_week','voice_finish'));

CREATE TABLE voice_minutes (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  utc_date date NOT NULL,
  reserved_minutes integer NOT NULL DEFAULT 0,
  used_minutes integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id,utc_date)
);
CREATE TABLE voice_calls (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, interview_id uuid NOT NULL,
  provider_call_id text NOT NULL UNIQUE, agent_id text NOT NULL,
  status text NOT NULL DEFAULT 'active', spend_reservation_id uuid NOT NULL,
  reserved_minutes integer NOT NULL, utc_date date NOT NULL,
  duration_seconds integer, transcript_revision integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz,
  UNIQUE(user_id,id), UNIQUE(user_id,interview_id),
  FOREIGN KEY (user_id,interview_id) REFERENCES interviews(user_id,id) ON DELETE CASCADE
);
CREATE INDEX voice_calls_owner ON voice_calls(user_id,interview_id);
CREATE TABLE voice_webhook_receipts (
  id uuid PRIMARY KEY, voice_call_id uuid NOT NULL REFERENCES voice_calls(id) ON DELETE CASCADE,
  event_type text NOT NULL, payload_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(voice_call_id,event_type,payload_hash)
);
CREATE TABLE voice_transcript_edits (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, voice_call_id uuid NOT NULL,
  turn_id uuid NOT NULL, previous_text text NOT NULL, corrected_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id,voice_call_id) REFERENCES voice_calls(user_id,id) ON DELETE CASCADE
);
