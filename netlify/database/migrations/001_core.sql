CREATE TABLE users (
  id uuid PRIMARY KEY, username text NOT NULL, normalized_username text NOT NULL UNIQUE,
  password_hash text NOT NULL, password_scheme text NOT NULL DEFAULT 'scrypt-v1',
  created_at timestamptz NOT NULL DEFAULT now(), password_changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_owner ON auth_sessions(user_id);
CREATE TABLE sources (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('resume','jd','user_assertion','transcript')),
  title text NOT NULL, text text NOT NULL, content_hash text NOT NULL,
  parent_source_id uuid, source_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,id),
  FOREIGN KEY (user_id,parent_source_id) REFERENCES sources(user_id,id)
);
CREATE INDEX sources_owner ON sources(user_id);
CREATE TABLE source_spans (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, source_id uuid NOT NULL,
  start_offset integer NOT NULL, end_offset integer NOT NULL, verbatim_quote text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,id),
  CHECK (start_offset >= 0 AND end_offset > start_offset),
  FOREIGN KEY (user_id,source_id) REFERENCES sources(user_id,id) ON DELETE CASCADE
);
CREATE INDEX spans_owner ON source_spans(user_id,source_id);
CREATE TABLE workspaces (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  jd_source_id uuid NOT NULL, label text NOT NULL, status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,id), FOREIGN KEY (user_id,jd_source_id) REFERENCES sources(user_id,id)
);
CREATE INDEX workspaces_owner ON workspaces(user_id);
CREATE TABLE facts (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid, domain text NOT NULL DEFAULT 'candidate' CHECK (domain IN ('candidate','job')),
  subject text NOT NULL, predicate text NOT NULL,
  value_json jsonb NOT NULL, qualifiers_json jsonb NOT NULL DEFAULT '{}', display_text text NOT NULL,
  status text NOT NULL CHECK (status IN ('document','user_confirmed','draft')),
  review_state text NOT NULL CHECK (review_state IN ('pending','accepted','rejected')),
  lifecycle text NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','superseded')),
  supersedes_fact_id uuid, confirmed_at timestamptz, discrepancy_note text,
  proposed_by text NOT NULL, validation_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,id),
  FOREIGN KEY (user_id,workspace_id) REFERENCES workspaces(user_id,id),
  FOREIGN KEY (user_id,supersedes_fact_id) REFERENCES facts(user_id,id)
);
CREATE INDEX facts_owner ON facts(user_id,review_state,lifecycle);
CREATE TABLE fact_evidence (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, fact_id uuid NOT NULL, span_id uuid NOT NULL,
  relation text NOT NULL CHECK (relation IN ('supports','conflicts','user_assertion')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id,fact_id) REFERENCES facts(user_id,id) ON DELETE CASCADE,
  FOREIGN KEY (user_id,span_id) REFERENCES source_spans(user_id,id) ON DELETE CASCADE
);
CREATE TABLE fact_events (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, fact_id uuid NOT NULL,
  event_type text NOT NULL, replacement_fact_id uuid, actor_kind text NOT NULL, reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id,fact_id) REFERENCES facts(user_id,id) ON DELETE CASCADE,
  FOREIGN KEY (user_id,replacement_fact_id) REFERENCES facts(user_id,id)
);
CREATE TABLE interviews (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, workspace_id uuid NOT NULL,
  mode text NOT NULL DEFAULT 'text', persona text NOT NULL DEFAULT 'hiring_manager',
  status text NOT NULL DEFAULT 'active', plan_json jsonb NOT NULL, rubric_version integer NOT NULL DEFAULT 1,
  started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,id),
  FOREIGN KEY (user_id,workspace_id) REFERENCES workspaces(user_id,id)
);
CREATE INDEX interviews_owner ON interviews(user_id,workspace_id);
CREATE TABLE interview_turns (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, interview_id uuid NOT NULL,
  sequence integer NOT NULL, speaker text NOT NULL CHECK (speaker IN ('interviewer','candidate')),
  text text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,interview_id,sequence),
  FOREIGN KEY (user_id,interview_id) REFERENCES interviews(user_id,id) ON DELETE CASCADE
);
CREATE TABLE artifacts (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, workspace_id uuid NOT NULL, interview_id uuid,
  kind text NOT NULL, revision integer NOT NULL DEFAULT 1, content_json jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('draft','validated','invalidated')),
  validator_version integer NOT NULL DEFAULT 1, model_id text, prompt_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,id),
  FOREIGN KEY (user_id,workspace_id) REFERENCES workspaces(user_id,id),
  FOREIGN KEY (user_id,interview_id) REFERENCES interviews(user_id,id)
);
CREATE TABLE artifact_claims (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, artifact_id uuid NOT NULL,
  clause_index integer NOT NULL, clause_text text NOT NULL, atomic_claim_json jsonb NOT NULL,
  validation_status text NOT NULL, failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,id),
  FOREIGN KEY (user_id,artifact_id) REFERENCES artifacts(user_id,id) ON DELETE CASCADE
);
CREATE TABLE artifact_claim_facts (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, claim_id uuid NOT NULL, fact_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id,claim_id) REFERENCES artifact_claims(user_id,id) ON DELETE CASCADE,
  FOREIGN KEY (user_id,fact_id) REFERENCES facts(user_id,id)
);
CREATE TABLE debriefs (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, interview_id uuid NOT NULL,
  transcript_revision integer NOT NULL DEFAULT 1, rubric_version integer NOT NULL DEFAULT 1,
  content_scores_json jsonb NOT NULL, delivery_scores_json jsonb NOT NULL,
  unassessed_json jsonb NOT NULL, feedback_json jsonb NOT NULL,
  unsupported_claims_json jsonb NOT NULL, rewrite_artifact_id uuid,
  status text NOT NULL DEFAULT 'ready', created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id,interview_id) REFERENCES interviews(user_id,id),
  FOREIGN KEY (user_id,rewrite_artifact_id) REFERENCES artifacts(user_id,id)
);
CREATE INDEX debriefs_owner ON debriefs(user_id,interview_id);
CREATE TABLE spend_days (
  utc_date date PRIMARY KEY, cap_micros bigint NOT NULL, reserved_micros bigint NOT NULL DEFAULT 0,
  settled_micros bigint NOT NULL DEFAULT 0
);
CREATE TABLE spend_reservations (
  id uuid PRIMARY KEY, utc_date date NOT NULL REFERENCES spend_days(utc_date),
  bucket text NOT NULL, estimated_micros bigint NOT NULL, actual_micros bigint,
  state text NOT NULL DEFAULT 'reserved', idempotency_key text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE abuse_windows (
  bucket text NOT NULL, subject_hmac text NOT NULL, window_start timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 1, expires_at timestamptz NOT NULL,
  PRIMARY KEY(bucket,subject_hmac,window_start)
);
