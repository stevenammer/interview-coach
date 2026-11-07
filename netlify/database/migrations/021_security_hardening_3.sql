-- Owner attribution makes signed-in model and voice reservations enforceable per account.
ALTER TABLE spend_reservations ADD COLUMN user_id uuid REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX spend_reservations_owner_day ON spend_reservations(user_id, utc_date, state);

-- Guest voice capability tokens are short-lived, independent of the Retell call lifecycle.
ALTER TABLE guest_voice_calls ADD COLUMN expires_at timestamptz NOT NULL DEFAULT (now() + interval '2 hours');
CREATE INDEX guest_voice_calls_expiry ON guest_voice_calls(expires_at);
