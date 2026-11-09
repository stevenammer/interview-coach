-- Guest reservations need a privacy-preserving subject for the per-IP daily dollar ceiling.
ALTER TABLE spend_reservations ADD COLUMN subject_hmac text;
CREATE INDEX spend_reservations_guest_subject_day ON spend_reservations(subject_hmac, utc_date, state);
