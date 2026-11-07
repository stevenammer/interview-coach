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

Storage reservations are serialized with a database row lock. Pending and completed original files count toward a 100 MB account cap and 1 GB site cap (pending files also have a 20 MB account cap). File counts, source text, retained model-job payloads, and request rates have separate bounds in code. These checks require every migration, including `023_resource_guard.sql`, before serving traffic. They don't prove that a hosted blob store can never contain an orphan after a platform failure. Monitor storage and backups as the operator.

The default production handler no longer persists personal Plain English rewrites in a shared blob cache. If upgrading an older deployment, remove its legacy `plain-cache` objects through your hosting account after checking retention needs; account deletion cannot enumerate that legacy shared cache. No automatic destructive hosting cleanup is included.

Uncertain dispatched model/voice requests retain their spend reservation for the original UTC day until actual usage or a definitive no-charge outcome settles them. This can temporarily reduce available practice budget; retrying an uncertain request is not treated as free. Model rates are reviewed estimates and provider billing still needs an external account budget.

Local regression tests and code review are not an independent security certification. CSP remains report-only pending a real Retell browser session. Live provider behavior, production database deployment, and hosted data cleanup require separate operator verification.
