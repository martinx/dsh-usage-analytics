# dsh-usage-analytics

Local usage / token / cost analytics for DeepSeek Harness, computed entirely from this
desktop's own session logs. No billing API, no third-party service, no uploads.

## Decisions (locked)

- **Content is not stored.** Only token buckets, model, provider, timestamps, session
  attribution and derived cost. Request detail links back to the original session.
- **Retention: forever.** Raw session logs stay where DSH keeps them; this plugin keeps
  an independent, deduplicated copy of the derived rows.
- **Costs use official DeepSeek pricing by default and are editable.** Prices are
  versioned rows in SQLite; a re-price pass can recompute history without touching
  token rows.
- **Holidays are a yearly, GitHub-maintained table** synced on demand. Once a year is
  fixed it does not change.
- **Dashboard opens as an in-app full-screen overlay** (iframe over a host-served SPA),
  so it shares the app's login state and never leaves the conversation. A signed
  short-lived URL can add "open in browser" later without changing the backend.

## Data source

`$DSH_HOME/sessions/<workspace>/<session>/session.v*.jsonl.zstd`

Relevant events:

| Event | Fields used |
|---|---|
| `session` | id, cwd, createdAt, agentPreset, version |
| `session/title` | title |
| `request/header` | config.provider, config.model, reasoningEffort, maxTokens |
| `step/start` | turn, step, time |
| `assistant/message` | time, data.turn/step, data.usage `{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens}` |

The parser folds the most recent `request/header` onto each following
`assistant/message`, so every billed request is attributed to its model even when the
header is only emitted on change.

## Schema

```
sessions(id, cwd, workspace, title, created_at, last_event_at, agent_preset, version)
requests(session_id, seq, ts, provider, model, reasoning_effort, turn, step,
         input_tokens, cache_read, cache_write, output_tokens,
         peak, price_source, cost_cny, latency_ms,
         PRIMARY KEY(session_id, seq))
prices(model, hit_peak, miss_peak, out_peak, hit_off, miss_off, out_off, currency)
ingest(path, size, mtime, last_seq, parsed_at)
holidays(date, name)
balance_snapshots(ts, wallets_json, total_cny)
settings(key, value)
```

## Cost model

- Official peak/off-peak pricing: peak = Beijing-time weekdays 09:00–12:00 and
  14:00–18:00, excluding Chinese public holidays; every other instant is off-peak.
- Peak prices (CNY / million tokens, 2026 official):

  | model | cache hit | cache miss | output |
  |---|---|---|---|
  | deepseek-flash | 0.02 (off) / 0.04 (peak) | 1 / 2 | 4 / 8 |
  | deepseek-v4-pro | 0.15 / 0.30 | 4.5 / 9 | 13.5 / 27 |

- `cost = (cacheRead*hit + (input+cacheWrite)*miss + output*out) / 1e6`
- Unknown models keep tokens and show no cost until a price row exists.

## Ingest

- Backfill every session file once; incremental re-scan only when `size` or `mtime`
  changed, skipping events at or below the recorded `last_seq` watermark.
- Idempotent `INSERT OR REPLACE` keyed by `(session_id, seq)`.
- Decompression via `node:zlib` zstd; unknown event types are ignored.
- Runs in the background on activation and every 60 s; `/api/reindex` forces a full pass.

## HTTP API (host routes)

| Route | Purpose |
|---|---|
| `GET /dsh-plugin/usage/api/status` | ingest counters, DB path, price/holiday coverage |
| `GET /dsh-plugin/usage/api/summary?from&to` | totals, cache hit rate, per-day, per-model |
| `GET /dsh-plugin/usage/api/models?from&to` | per-model breakdown |
| `GET /dsh-plugin/usage/api/sessions?from&to&limit&offset` | per-session cost ranking |
| `GET /dsh-plugin/usage/api/requests?from&to&model&session&limit&offset` | request log |
| `GET /dsh-plugin/usage/api/balance` | account wallets (free Platform summary read) |
| `POST /dsh-plugin/usage/api/reindex` | force a full ingest |

## Roadmap

- **P0** host ingest + SQLite + cost engine + JSON API (this phase)
- **P1** dock balance pill (last slot, after the context meter) + overview popover
- **P2** dashboard SPA: Overview / Models / Sessions / Requests / Cost & Balance / Settings
- **P3** balance reconciliation, budget alerts, exports, holiday sync, Search/Fetch cost
