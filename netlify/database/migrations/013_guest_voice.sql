-- Guest voice calls: spend and cap bookkeeping only. No transcript or profile content is stored.
CREATE TABLE guest_voice_calls (
  provider_call_id text PRIMARY KEY,
  token_hash text NOT NULL,
  spend_reservation_id uuid NOT NULL,
  reserved_minutes integer NOT NULL,
  utc_date date NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','settled')),
  duration_seconds integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE guest_voice_pool (
  utc_date date PRIMARY KEY,
  reserved_minutes integer NOT NULL DEFAULT 0
);
