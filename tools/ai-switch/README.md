# Explicit AI provider switch

Install the directory on Timeweb as `/usr/local/lib/finnik-ai-switch`, root-owned. Entry point `/usr/local/sbin/finnik-ai-switch` executes `/usr/bin/node /usr/local/lib/finnik-ai-switch/cli.mjs "$@"`.

```bash
finnik-ai-switch stage status
finnik-ai-switch stage openai --check-only
finnik-ai-switch stage openai
finnik-ai-switch stage rollback
finnik-ai-switch stage yandex
```

The command selects text, statement and voice together. It leaves Telegram/OpenAI relay endpoints, model names, credentials and other settings unchanged. Without provider selectors, the app defaults to OpenAI. Each change performs real (billable) requests using a synthetic image showing 350 and a public official SpeechKit audio sample; no user data or DB writes. Text/vision requests have 60 s timeouts, voice uses its own 120 s timeout plus cleanup. Probes run sequentially and can take several minutes during failure. A successful API preflight does not replace manual Telegram/web testing.

Root only; lock per environment; env must be a regular private file. Snapshots and a latest journal are private under `/root/finnik-ai-switch/stage` (or prod). Failed readiness restores the old env and restarts it; the command reports whether recovery succeeded. A concurrent env change is not overwritten. If interrupted, inspect the service, env and journal before manually clearing the stale lock. Never print snapshots: they contain secrets.

`rollback` probes and restores the exact snapshot from the latest actual switch. It refuses if any setting changed afterwards; in that case choose the desired provider explicitly to preserve other edits. `--check-only` performs probes without editing env, journal or restarting. Re-selecting the current provider also probes but does not restart.

Readiness = selected systemd service active and local /cabinet/login HTTP 200. It does not prove a live Telegram user interaction or a payment flow.

## Production boundary

This work is installed/tested for stage only. The interface includes `prod`, but the existing prod ef2ccc0 lacks the provider modules/keys, so switching fails before any changes. Do not use prod until an explicitly approved provider-capable application release and credentials are deployed. Installing this helper is not a production AI integration.

## Relation to relays

`finnik-relay-switch stage primary|backup` controls network routes separately. Yandex AI does not restore Telegram if both relays fail. In that scenario web text can use Yandex, alerts rely on email, and channel announcements must be published manually.
