# Security

## Reporting a problem

Please don't open a public issue for a security bug. Use GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability"). If that isn't available, open an issue that says only that you have a security report, with no details, and I'll set up a private channel.

This is a side project run by one person. I'll answer when I can and I'll credit you if you'd like.

## What the code does

- Passwords are hashed with scrypt. Sessions use HttpOnly, SameSite=Strict cookies (`__Host-` prefixed and Secure over HTTPS).
- POST requests to `/api` need a same-origin `Origin` header (or one in `ALLOWED_ORIGINS`), a custom CSRF header, and a JSON content type.
- Rate limits use HMAC-hashed identities, keyed by `ABUSE_HMAC_KEY`. The API refuses to run without a key of 24+ characters.
- Model calls are reserved against a daily spend cap before they run.
- The Content Security Policy in `netlify.toml` is report-only, not enforced.

## What you must do when you deploy

- Set a long random `ABUSE_HMAC_KEY` and a `DAILY_USD_CAP` you're comfortable losing.
- Keep API keys in your host's environment settings, never in the repo.
- Rotate any key that has ever been pasted into a chat, log, or issue.
- Tell your users that you, as the operator, can read the database.

## Known limits

No third-party security audit. AI output is untrusted text; the app escapes it for display, but treat it carefully if you change the rendering code.

Storage controls are incomplete. Pending-upload checks can race across simultaneous upload initializations, and completed files have no overall account or deployment storage quota. Exact chunk lengths bound each upload, but they don't cap cumulative storage. Use trusted accounts and monitor storage until those limits are enforced.
