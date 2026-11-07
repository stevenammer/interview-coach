CREATE TABLE fact_conflict_reviews (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid,
  fact_a_id uuid NOT NULL,
  fact_b_id uuid NOT NULL,
  content_fingerprint text NOT NULL CHECK (content_fingerprint ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('open','context_review','resolved')),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0 AND length(reason) <= 500),
  context_note text CHECK (context_note IS NULL OR (length(btrim(context_note)) > 0 AND length(context_note) <= 500)),
  review_history jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(review_history)='array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (fact_a_id <> fact_b_id),
  UNIQUE (user_id,fact_a_id,fact_b_id,content_fingerprint),
  FOREIGN KEY (user_id,workspace_id) REFERENCES workspaces(user_id,id) ON DELETE CASCADE,
  FOREIGN KEY (user_id,fact_a_id) REFERENCES facts(user_id,id) ON DELETE CASCADE,
  FOREIGN KEY (user_id,fact_b_id) REFERENCES facts(user_id,id) ON DELETE CASCADE
);
CREATE INDEX fact_conflict_reviews_owner ON fact_conflict_reviews(user_id,workspace_id,status);
