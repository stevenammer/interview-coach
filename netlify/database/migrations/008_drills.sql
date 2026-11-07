ALTER TABLE workspaces ADD COLUMN interview_date timestamptz;
CREATE TABLE drill_cards (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, workspace_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('story','intro')),
  target_seconds integer, cue text NOT NULL, fact_ids jsonb NOT NULL,
  schedule_json jsonb NOT NULL, status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,id),
  FOREIGN KEY (user_id,workspace_id) REFERENCES workspaces(user_id,id) ON DELETE CASCADE
);
CREATE INDEX drill_cards_owner ON drill_cards(user_id,workspace_id);
CREATE TABLE drill_reviews (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, card_id uuid NOT NULL,
  answer text NOT NULL, hit_ids jsonb NOT NULL, missed_ids jsonb NOT NULL,
  rating text NOT NULL, reviewed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id,card_id) REFERENCES drill_cards(user_id,id) ON DELETE CASCADE
);
CREATE INDEX drill_reviews_owner ON drill_reviews(user_id,card_id);
