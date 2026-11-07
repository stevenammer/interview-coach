CREATE TABLE rewrite_slots (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  interview_id uuid NOT NULL,
  label text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','proposed','waived')),
  proposal_fact_id uuid,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE(user_id,id),
  FOREIGN KEY (user_id,interview_id) REFERENCES interviews(user_id,id) ON DELETE CASCADE,
  FOREIGN KEY (user_id,proposal_fact_id) REFERENCES facts(user_id,id)
);
CREATE INDEX rewrite_slots_owner ON rewrite_slots(user_id,interview_id);
