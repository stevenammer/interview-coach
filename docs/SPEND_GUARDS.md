# Spend guards

Interview Coach defaults to its public behavior unless an environment variable below says otherwise. A value of `false` or `0` disables only the three feature switches. All dollar values are USD.

| Control | Environment variable | Default | At the limit |
| --- | --- | --- | --- |
| Entire model and voice ledger | `DAILY_USD_CAP` | `15` | New reservations return 503. Existing reservations can still settle. |
| Signed-in share of the daily ledger | none | 50% of the daily cap, with room for one 30-minute voice reservation | New signed-in model or voice reservations return 503. |
| Guest share of the daily ledger | `GUEST_BUDGET_FRACTION` | `0.4` | Guest model and voice reservations return 503. |
| Guest IP daily ledger | `GUEST_IP_DAILY_USD` | `3.00` | Guest model and voice reservations from that IP bucket return 503. IPv6 uses a /64 bucket. |
| Model reservation | none | `$0.25` per attempt | A timeout or response without usage metadata settles at the full reservation. A definite non-2xx provider rejection releases it. |
| Reservation lifetime | none | 15 minutes for models, 120 minutes for voice | Expired rows release their hold. A late voice settlement is still recorded. |
| Signed-in voice call length | `VOICE_MAX_MINUTES` | 30 minutes | Retell receives the call maximum. |
| Signed-in voice minutes | `VOICE_DAILY_MINUTES_LIMIT` | 90 minutes | Voice start returns 503. |
| Guest voice call length | `GUEST_VOICE_MAX_MINUTES` | 5 minutes | Retell receives the call maximum. |
| Guest voice calls per IP bucket | `GUEST_VOICE_CALLS_PER_DAY` | 2 | Voice start returns 429. |
| Guest voice minutes, shared | `GUEST_VOICE_DAILY_MINUTES` | 60 minutes | Voice start returns 503. |
| New accounts, shared UTC day | `SIGNUP_DAILY_CAP` | 200 | Signup returns 503. |
| Signed-in model operations | `MODEL_OPS_PER_HOUR_PER_ACCOUNT` | 120 per account per hour | The operation returns 429. |
| Guest model operations | none | 60 per IP bucket per hour | The operation returns 429. |
| Guest free operations | none | 400 per IP bucket per hour | The operation returns 429. |
| Guests | `GUESTS_ENABLED` | enabled | `false` or `0` makes guest API requests return 503. |
| Signups | `SIGNUP_ENABLED` | enabled | `false` or `0` makes signup return 503. |
| Voice | `VOICE_ENABLED` | enabled | `false` or `0` makes voice endpoints return 503. |

The ledger uses UTC calendar days. The code stores only HMACs of abuse subjects, not raw IP addresses. IPv4-mapped IPv6 addresses normalize to their IPv4 form.

## Provider controls

The app can't enforce provider or hosting spend limits. Before public access, set and periodically verify a hard voice-provider spend limit, cloud billing budget alerts and quotas, hosting spend alerts, and production values for `ABUSE_HMAC_KEY`, `DAILY_USD_CAP`, and the feature switches.

## Concurrent requests

This fork serializes reservations with a database lock, so the global, account, guest-pool, and guest-IP checks observe the preceding committed reservation.
