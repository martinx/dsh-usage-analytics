# dsh-usage-analytics

Local usage, token and cost analytics for DeepSeek Harness — built from this desktop's own
session logs. No billing API, no external service, nothing uploaded.

- Full request-level records: model/provider, turn/step, token buckets, peak/off-peak price,
  CNY cost, latency
- SQLite store with idempotent incremental ingest from `$DSH_HOME/sessions`
- Official 2026 DeepSeek pricing, editable; yearly holiday table (bundled + syncable)
- Serves a read-only JSON API for the dock pill and the dashboard

See [docs/design.md](docs/design.md) for the data model, cost rules and roadmap.

## Verify locally

```bash
node scripts/ingest.mjs            # default DB under $DSH_HOME/storages/usage-analytics
node scripts/ingest.mjs /tmp/u.db  # throwaway database
```

## Dashboard

The dashboard follows the app theme (`?theme=light|dark` passed by the pill) and fills the current DSH window. On macOS it starts below the app's title strip, so the native traffic lights stay over the app chrome instead of the dashboard; X (or Esc) closes it; a ⤢ button toggles full screen, which also hides the native traffic lights.

## Status

- P0: ingest + SQLite + cost engine + JSON API
- P1: dock balance pill + overview popover (balance moved here from `dsh-workspace-status`)
- P2: dashboard SPA at `/dsh-plugin/usage/` (Overview / Models / Sessions / Requests / Cost & Balance / Settings), full-screen in-app overlay, Chinese UI
- P3: reconciliation, budget alerts, exports, holiday sync
