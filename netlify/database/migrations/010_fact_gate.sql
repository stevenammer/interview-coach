ALTER TABLE debriefs ADD COLUMN fact_gate_json jsonb NOT NULL DEFAULT '[]';
CREATE TABLE fact_gate_decisions (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, interview_id uuid NOT NULL,
  lane text NOT NULL, answer_quote text NOT NULL,
  choice text NOT NULL CHECK (choice IN ('confirm','use_range','qualitative','drop','precise')),
  proposal_fact_id uuid, note text, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,interview_id,lane,answer_quote),
  FOREIGN KEY (user_id,interview_id) REFERENCES interviews(user_id,id) ON DELETE CASCADE,
  FOREIGN KEY (user_id,proposal_fact_id) REFERENCES facts(user_id,id)
);
CREATE INDEX fact_gate_decisions_owner ON fact_gate_decisions(user_id,interview_id);
