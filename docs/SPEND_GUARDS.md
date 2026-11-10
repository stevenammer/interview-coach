# Spend guards

Interview Coach ships with strict defaults. Raise any of them with the environment variable shown. A value of `false` or `0` disables only the three feature switches. All dollar values are USD.

| Control | Environment variable | Default | At the limit |
| --- | --- | --- | --- |
| Entire model and voice ledger | `DAILY_USD_CAP` | `15` | New reservations return 503. Existing reservations can still settle. |
| Signed-in share of the daily ledger | none | 50% of the daily cap, with room for one full voice reservation | New signed-in model or voice reservations return 503. |
| Guest share of the daily ledger | `GUEST_BUDGET_FRACTION` | `0.4` | Guest model and voice reservations return 503. |
| Guest IP daily ledger | `GUEST_IP_DAILY_USD` | `3.00` | Guest model and voice reservations from that IP bucket return 503. IPv6 uses a /64 bucket. |
| Model reservation | none | At least `$0.25` per attempt; larger byte-based input and output estimates can require more | A timeout or response without usage metadata settles at the full reservation. A definite 4xx provider rejection other than HTTP 408 releases it; unknown outcomes retain it. |
| Reservation expiry | none | 15 minutes for models, 120 minutes for voice | An unknown hold remains for its original UTC day even after its expiry time. After the day changes, an expired hold can be released; late actual usage is recorded on the original day. |
| Signed-in voice call length | `VOICE_MAX_MINUTES` | 10 minutes | Retell receives the call maximum. |
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

## Defaults at a glance

The daily ledger is `$15` (`DAILY_USD_CAP`). Guests may use 40% of it, which is `$6.00`, so about six 5-minute guest voice calls a day in total, or a lot of text practice. A 5-minute guest voice call reserves `$1.00` at `$0.20` a minute. The fixed `$3.00` guest-IP ledger has room for three such reservations, but the default two-calls-per-IP limit is stricter. A signed-in voice call is 10 minutes (`VOICE_MAX_MINUTES`) and reserves `$2.00` at `$0.20` a minute. Each signed-in account is held to half of the cap, `$7.50`, which permits about three such calls before its spend share is exhausted. The 60-minute guest pool and 90-minute signed-in voice limit still apply.

## Provider controls

The app can't enforce provider or hosting spend limits. Before public access, set and periodically verify a hard voice-provider spend limit, cloud billing budget alerts and quotas, hosting spend alerts, and production values for `ABUSE_HMAC_KEY`, `DAILY_USD_CAP`, and the feature switches.

## Concurrent requests

This fork serializes reservations with a database lock, so the global, account, guest-pool, and guest-IP checks observe the preceding committed reservation.
