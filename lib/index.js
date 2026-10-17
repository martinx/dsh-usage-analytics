// dsh-usage-analytics — host half.
//
// Builds a local, deduplicated analytics store from this desktop's own DSH
// session logs (zstd JSONL), derives token buckets and CNY cost, and serves a
// read-only JSON API for the dock pill and the dashboard SPA.
//
// Nothing here calls a billing API; the only network reads are the optional
// account balance summary (free) and the yearly holiday table.
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const execFileAsync = promisify(execFile)

export const name = 'dsh-usage-analytics'
export const inject = ['webServer']

const ROUTE = '/dsh-plugin/usage/api'
const DB_RELATIVE = 'storages/usage-analytics/usage.db'
const SCAN_INTERVAL_MS = 60_000
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const ACCOUNT_CREDENTIAL_KEY = 'deepseek-account-platform/default'

/** Official peak-hour prices in CNY per million tokens (2026-10 official page). */
const DEFAULT_PRICES = [
  { model: 'deepseek-flash', hitPeak: 0.04, missPeak: 2, outPeak: 8 },
  { model: 'deepseek-v4-pro', hitPeak: 0.3, missPeak: 9, outPeak: 27 },
  { model: 'deepseek-v4-flash', hitPeak: 0.04, missPeak: 2, outPeak: 8 },
  { model: 'deepseek-chat', hitPeak: 0.04, missPeak: 2, outPeak: 8 },
  { model: 'deepseek-reasoner', hitPeak: 0.04, missPeak: 2, outPeak: 8 },
]

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY,
  cwd TEXT,
  workspace TEXT,
  title TEXT,
  created_at INTEGER,
  last_event_at INTEGER,
  agent_preset TEXT,
  version INTEGER
);
CREATE TABLE IF NOT EXISTS requests(
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  provider TEXT,
  model TEXT,
  reasoning_effort TEXT,
  turn INTEGER,
  step INTEGER,
  input_tokens INTEGER DEFAULT 0,
  cache_read INTEGER DEFAULT 0,
  cache_write INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  peak INTEGER DEFAULT 0,
  price_source TEXT,
  cost_cny REAL,
  latency_ms INTEGER,
  PRIMARY KEY(session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts);
CREATE INDEX IF NOT EXISTS idx_requests_model_ts ON requests(model, ts);
CREATE INDEX IF NOT EXISTS idx_requests_session ON requests(session_id);
CREATE TABLE IF NOT EXISTS ingest(
  path TEXT PRIMARY KEY,
  size INTEGER,
  mtime INTEGER,
  last_seq INTEGER,
  parsed_at INTEGER
);
CREATE TABLE IF NOT EXISTS prices(
  model TEXT PRIMARY KEY,
  hit_peak REAL, miss_peak REAL, out_peak REAL,
  hit_off REAL, miss_off REAL, out_off REAL,
  currency TEXT,
  source TEXT,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS holidays(
  date TEXT PRIMARY KEY,
  name TEXT
);
CREATE TABLE IF NOT EXISTS balance_snapshots(
  ts INTEGER PRIMARY KEY,
  wallets_json TEXT,
  total_cny REAL
);
CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY,
  value TEXT
);
`

function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

function defaultDbPath() {
  return join(dshHome(), DB_RELATIVE)
}

/**
 * Open (and migrate) the analytics database.
 * @param {string} [dbPath] absolute database path
 */
export function openDatabase(dbPath = defaultDbPath()) {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(SCHEMA)
  const holidayCount = db.prepare('SELECT COUNT(*) c FROM holidays').get().c
  if (holidayCount === 0) {
    try {
      const bundled = JSON.parse(readFileSync(new URL('../data/holidays/2026.json', import.meta.url), 'utf8'))
      const insertHoliday = db.prepare('INSERT OR IGNORE INTO holidays(date, name) VALUES (?, ?)')
      for (const group of bundled.holidays ?? []) {
        for (const date of group.dates ?? []) insertHoliday.run(date, group.name ?? null)
      }
    } catch {
      // A missing bundled table only costs peak-hour precision, never ingest.
    }
  }
  const insert = db.prepare(`INSERT OR IGNORE INTO prices
    (model, hit_peak, miss_peak, out_peak, hit_off, miss_off, out_off, currency, source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'CNY', 'official-2026-10', ?)`)
  const now = Date.now()
  for (const price of DEFAULT_PRICES) {
    insert.run(price.model, price.hitPeak, price.missPeak, price.outPeak,
      price.hitPeak / 2, price.missPeak / 2, price.outPeak / 2, now)
  }
  return db
}

/** Read the price table into a Map keyed by model. */
function loadPrices(db) {
  const rows = db.prepare('SELECT * FROM prices').all()
  return new Map(rows.map((row) => [row.model, row]))
}

const SHANGHAI = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
})

/**
 * Beijing-time calendar fields for one epoch millisecond.
 * @param {number} ms epoch ms
 */
export function shanghaiParts(ms) {
  const parts = {}
  for (const part of SHANGHAI.formatToParts(new Date(ms))) parts[part.type] = part.value
  let hour = Number(parts.hour)
  if (hour === 24) hour = 0
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour,
    minute: Number(parts.minute),
    weekday: parts.weekday,
  }
}

/**
 * Whether an instant falls in DeepSeek's peak pricing window.
 * Peak is Beijing-time weekdays 09:00–12:00 and 14:00–18:00, excluding
 * configured Chinese public holidays.
 * @param {number} ms epoch ms
 * @param {Set<string>} holidays configured holiday dates (YYYY-MM-DD)
 */
export function isPeak(ms, holidays = new Set()) {
  const { date, hour, minute, weekday } = shanghaiParts(ms)
  if (holidays.has(date)) return false
  if (weekday === 'Sat' || weekday === 'Sun') return false
  const time = hour + minute / 60
  return (time >= 9 && time < 12) || (time >= 14 && time < 18)
}

/**
 * Cost in CNY for one request's token buckets.
 * @param {{input:number, cacheRead:number, cacheWrite:number, output:number}} usage
 * @param {Record<string, number>} price price row
 * @param {boolean} peak peak window
 */
export function costOf(usage, price, peak) {
  const hit = peak ? price.hit_peak : price.hit_off
  const miss = peak ? price.miss_peak : price.miss_off
  const out = peak ? price.out_peak : price.out_off
  const promptMiss = (usage.input + usage.cacheWrite)
  return (usage.cacheRead * hit + promptMiss * miss + usage.output * out) / 1_000_000
}

/**
 * Decompress a DSH session log. DSH appends one zstd frame per write, and
 * Node's zstd decoder stops after the first frame, so prefer the system zstd
 * binary and fall back to the single-frame Node decoder only when it is absent.
 * @param {string} path session log path
 * @returns {Promise<string>} decompressed UTF-8 text
 */
async function decompressSessionFile(path) {
  for (const binary of ['zstd', '/opt/homebrew/bin/zstd', '/usr/local/bin/zstd']) {
    try {
      const { stdout } = await execFileAsync(binary, ['-dc', path], {
        maxBuffer: 512 * 1024 * 1024,
        encoding: 'utf8',
      })
      return stdout
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return zstdDecompressSync(readFileSync(path)).toString('utf8')
}

/** List every session log under a sessions root. */
function listSessionFiles(root) {
  try {
    if (!existsSync(root)) return []
    return readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /^session\.v\d+\.jsonl\.zstd$/.test(entry.name))
      .map((entry) => join(entry.parentPath ?? entry.path, entry.name))
  } catch {
    return []
  }
}

/** Session id from a log path (`session-<uuid>` or a bare uuid directory). */
function sessionIdFromPath(path) {
  const dir = basename(dirname(path))
  return dir.startsWith('session-') ? dir : `session-${dir}`
}

/**
 * Ingest one session file. Unchanged files (same size + mtime) are skipped.
 * @returns {Promise<{ skipped: boolean, requests: number, lastSeq: number }>}
 */
async function ingestFile(db, path, state) {
  const stat = statSync(path)
  const previous = state.get(path)
  if (previous !== undefined && previous.size === stat.size && previous.mtime === Math.floor(stat.mtimeMs)) {
    return { skipped: true, requests: 0, lastSeq: previous.last_seq ?? 0 }
  }
  const text = await decompressSessionFile(path)
  const sessionId = sessionIdFromPath(path)
  const upsertSession = db.prepare(`INSERT INTO sessions(id, cwd, workspace, title, created_at, last_event_at, agent_preset, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      cwd = COALESCE(excluded.cwd, sessions.cwd),
      workspace = COALESCE(excluded.workspace, sessions.workspace),
      title = COALESCE(excluded.title, sessions.title),
      created_at = COALESCE(sessions.created_at, excluded.created_at),
      last_event_at = MAX(COALESCE(sessions.last_event_at, 0), COALESCE(excluded.last_event_at, 0)),
      agent_preset = COALESCE(excluded.agent_preset, sessions.agent_preset),
      version = COALESCE(excluded.version, sessions.version)`)
  const updateTitle = db.prepare('UPDATE sessions SET title = ? WHERE id = ?')
  const upsertRequest = db.prepare(`INSERT OR REPLACE INTO requests
    (session_id, seq, ts, provider, model, reasoning_effort, turn, step,
     input_tokens, cache_read, cache_write, output_tokens, peak, price_source, cost_cny, latency_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)

  let header = {}
  let stepStart = null
  let lastSeq = previous?.last_seq ?? -1
  let inserted = 0
  let sessionCwd = null
  let sessionPreset = null
  let sessionVersion = null
  let createdAt = null
  let lastEventAt = null
  let title = null

  db.exec('BEGIN')
  try {
    for (const line of text.split('\n')) {
      if (line === '') continue
      let event
      try { event = JSON.parse(line) } catch { continue }
      const seq = typeof event.seq === 'number' ? event.seq : null
      if (seq !== null && seq > lastSeq) lastSeq = seq
      const time = typeof event.time === 'number' ? event.time : null
      if (time !== null) lastEventAt = time
      switch (event.type) {
        case 'session':
          sessionCwd = typeof event.cwd === 'string' ? event.cwd : null
          sessionPreset = typeof event.agentPreset === 'string' ? event.agentPreset : null
          sessionVersion = typeof event.version === 'number' ? event.version : null
          createdAt = typeof event.createdAt === 'number' ? event.createdAt : null
          break
        case 'session/title':
          title = typeof event.data?.title === 'string' ? event.data.title : title
          break
        case 'request/header':
          header = event.data?.header?.config ?? {}
          break
        case 'step/start':
          stepStart = { time, turn: event.data?.turn, step: event.data?.step }
          break
        case 'assistant/message': {
          const usage = event.data?.usage
          if (usage === undefined || time === null) break
          const model = typeof header.model === 'string' ? header.model : null
          const provider = typeof header.provider === 'string' ? header.provider : null
          const price = model === null ? undefined : state.prices.get(model)
          const peak = isPeak(time, state.holidays)
          const buckets = {
            input: Number(usage.inputTokens ?? 0),
            cacheRead: Number(usage.cacheReadTokens ?? 0),
            cacheWrite: Number(usage.cacheWriteTokens ?? 0),
            output: Number(usage.outputTokens ?? 0),
          }
          const cost = price === undefined ? null : costOf(buckets, price, peak)
          upsertRequest.run(
            sessionId, seq ?? 0, time, provider, model,
            typeof header.reasoningEffort === 'string' ? header.reasoningEffort : null,
            event.data?.turn ?? null, event.data?.step ?? null,
            buckets.input, buckets.cacheRead, buckets.cacheWrite, buckets.output,
            peak ? 1 : 0, price === undefined ? 'missing' : (price.source ?? 'official'),
            cost, stepStart?.time === undefined || stepStart?.time === null ? null : Math.max(0, time - stepStart.time),
          )
          inserted += 1
          break
        }
        default:
          break
      }
    }
    upsertSession.run(
      sessionId,
      sessionCwd,
      sessionCwd === null ? null : `${basename(dirname(sessionCwd))}/${basename(sessionCwd)}`,
      title, createdAt, lastEventAt, sessionPreset, sessionVersion,
    )
    if (title !== null) updateTitle.run(title, sessionId)
    state.set(path, {
      size: stat.size,
      mtime: Math.floor(stat.mtimeMs),
      last_seq: lastSeq,
      parsed_at: Date.now(),
    })
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return { skipped: false, requests: inserted, lastSeq }
}

/**
 * Ingest every session file under the sessions root. Re-parses a file only
 * when its size or mtime changed; event rows are idempotent by (session, seq).
 * @param {DatabaseSync} db database from openDatabase()
 * @param {{ sessionsRoot?: string, onProgress?: (done: number, total: number) => void }} [options]
 */
export async function ingestAll(db, options = {}) {
  const sessionsRoot = options.sessionsRoot ?? join(dshHome(), 'sessions')
  const files = listSessionFiles(sessionsRoot)
  const state = new Map(db.prepare('SELECT path, size, mtime, last_seq FROM ingest').all().map((row) => [row.path, row]))
  const prices = loadPrices(db)
  const holidays = new Set(db.prepare('SELECT date FROM holidays').all().map((row) => row.date))
  const upsertState = db.prepare(`INSERT INTO ingest(path, size, mtime, last_seq, parsed_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime,
      last_seq = excluded.last_seq, parsed_at = excluded.parsed_at`)
  const ctxState = { prices, holidays, get: (path) => state.get(path), set: (path, row) => { state.set(path, row); upsertState.run(path, row.size, row.mtime, row.last_seq, row.parsed_at) } }
  let requests = 0
  let filesParsed = 0
  for (let index = 0; index < files.length; index += 1) {
    try {
      const result = await ingestFile(db, files[index], ctxState)
      if (!result.skipped) { filesParsed += 1; requests += result.requests }
    } catch (error) {
      // A corrupt or future-format session must not block the rest.
      process.emitWarning?.(`dsh-usage-analytics: skipped ${files[index]}: ${String(error).slice(0, 160)}`)
    }
    if (index % 5 === 0) await new Promise((resolve) => setImmediate(resolve))
    options.onProgress?.(index + 1, files.length)
  }
  return { files: files.length, filesParsed, requests }
}

// ---------------------------------------------------------------- API queries

function range(params) {
  const from = Number(params.get('from') ?? 0)
  const to = Number(params.get('to') ?? Date.now())
  return {
    from: Number.isFinite(from) ? from : 0,
    to: Number.isFinite(to) ? to : Date.now(),
  }
}

function limitOffset(params) {
  const limit = Math.min(500, Math.max(1, Number(params.get('limit') ?? 50)))
  const offset = Math.max(0, Number(params.get('offset') ?? 0))
  return { limit: Number.isFinite(limit) ? limit : 50, offset: Number.isFinite(offset) ? offset : 0 }
}

function totals(db, from, to) {
  return db.prepare(`SELECT COUNT(*) requests,
      COALESCE(SUM(input_tokens),0) input, COALESCE(SUM(cache_read),0) cacheRead,
      COALESCE(SUM(cache_write),0) cacheWrite, COALESCE(SUM(output_tokens),0) output,
      COALESCE(SUM(cost_cny),0) cost, COALESCE(AVG(latency_ms),0) latency
    FROM requests WHERE ts >= ? AND ts <= ?`).get(from, to)
}

export function summary(db, from, to) {
  const all = totals(db, from, to)
  const prompt = all.input + all.cacheRead + all.cacheWrite
  const byModel = db.prepare(`SELECT model, COUNT(*) requests,
      SUM(input_tokens) input, SUM(cache_read) cacheRead, SUM(output_tokens) output,
      SUM(cost_cny) cost
    FROM requests WHERE ts >= ? AND ts <= ? GROUP BY model ORDER BY cost DESC`).all(from, to)
  const daily = db.prepare(`SELECT date(ts / 1000, 'unixepoch', '+8 hours') day,
      COUNT(*) requests, SUM(cost_cny) cost, SUM(output_tokens) output,
      SUM(cache_read) cacheRead, SUM(input_tokens) input
    FROM requests WHERE ts >= ? AND ts <= ? GROUP BY day ORDER BY day`).all(from, to)
  return {
    ok: true,
    range: { from, to },
    totals: {
      ...all,
      cacheHitRate: prompt === 0 ? 0 : all.cacheRead / prompt,
      avgCost: all.requests === 0 ? 0 : all.cost / all.requests,
    },
    byModel,
    daily,
  }
}

export function modelBreakdown(db, from, to) {
  return {
    ok: true,
    models: db.prepare(`SELECT model, provider, COUNT(*) requests,
        SUM(input_tokens) input, SUM(cache_read) cacheRead, SUM(cache_write) cacheWrite,
        SUM(output_tokens) output, SUM(cost_cny) cost,
        AVG(latency_ms) latency, AVG(peak) peakShare
      FROM requests WHERE ts >= ? AND ts <= ?
      GROUP BY model, provider ORDER BY cost DESC`).all(from, to),
  }
}

export function sessionBreakdown(db, from, to, { limit, offset }) {
  return {
    ok: true,
    sessions: db.prepare(`SELECT r.session_id AS id, s.cwd, s.workspace, s.title,
        COUNT(*) requests, SUM(r.input_tokens) input, SUM(r.cache_read) cacheRead,
        SUM(r.output_tokens) output, SUM(r.cost_cny) cost,
        MAX(r.ts) lastAt
      FROM requests r LEFT JOIN sessions s ON s.id = r.session_id
      WHERE r.ts >= ? AND r.ts <= ?
      GROUP BY r.session_id ORDER BY cost DESC LIMIT ? OFFSET ?`).all(from, to, limit, offset),
  }
}

export function requestLog(db, from, to, { limit, offset }, filters = {}) {
  const where = ['ts >= ?', 'ts <= ?']
  const args = [from, to]
  if (typeof filters.model === 'string' && filters.model !== '') { where.push('model = ?'); args.push(filters.model) }
  if (typeof filters.session === 'string' && filters.session !== '') { where.push('session_id = ?'); args.push(filters.session) }
  return {
    ok: true,
    requests: db.prepare(`SELECT session_id, seq, ts, provider, model, reasoning_effort, turn, step,
        input_tokens, cache_read, cache_write, output_tokens, cost_cny, peak, latency_ms
      FROM requests WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT ? OFFSET ?`).all(...args, limit, offset),
  }
}

// ------------------------------------------------------------ account balance

async function readAccountGrant(ctx) {
  try {
    const credentials = ctx.credentials
    if (!credentials || typeof credentials.readRecord !== 'function') return null
    const record = await credentials.readRecord(ACCOUNT_CREDENTIAL_KEY)
    if (record === undefined || record === null || record.kind !== 'grant') return null
    const payload = typeof record.payload === 'string' ? JSON.parse(record.payload) : record.payload
    if (payload === null || typeof payload !== 'object'
      || typeof payload.token !== 'string' || typeof payload.issuer !== 'string') return null
    return { token: payload.token, issuer: payload.issuer }
  } catch {
    return null
  }
}

function grantFromFile() {
  try {
    const file = join(dshHome(), '.credentials.yaml')
    if (!existsSync(file)) return null
    const lines = readFileSync(file, 'utf8').split('\n')
    let inBlock = false
    const fields = {}
    for (const line of lines) {
      if (/^\s{2}deepseek-account-platform\/default:\s*$/.test(line)) { inBlock = true; continue }
      if (!inBlock) continue
      const indent = line.length - line.trimStart().length
      if (line.trim() === '') continue
      if (indent <= 3) break
      const match = /^\s{6}([A-Za-z0-9_-]+):\s*(.+?)\s*$/.exec(line)
      if (match !== null) fields[match[1]] = match[2]
    }
    if (!fields.token || !fields.issuer) return null
    return { token: fields.token, issuer: fields.issuer }
  } catch {
    return null
  }
}

function normalizeWallets(list) {
  if (!Array.isArray(list)) return []
  return list.map((wallet) => ({ currency: String(wallet.currency ?? ''), balance: String(wallet.balance ?? '') }))
}

async function accountBalance(ctx, meta) {
  try {
    const account = ctx.deepseekAccount
    if (account && typeof account.getState === 'function' && typeof account.getBalance === 'function') {
      const state = await account.getState()
      if (state?.status === 'credential-stored') {
        const value = await account.getBalance(meta)
        if (value?.status === 'ready') {
          return { ok: true, via: 'service', wallets: normalizeWallets(value.value), bonusWallets: normalizeWallets(value.bonusWallets) }
        }
      }
    }
  } catch {
    // Fall through to the direct grant read.
  }
  const grant = (await readAccountGrant(ctx)) ?? grantFromFile()
  if (grant === null) return { ok: false, reason: 'no-account' }
  try {
    const response = await fetch(`${grant.issuer}/api/v0/users/get_user_summary`, {
      headers: {
        'x-dsh-auth-token': grant.token,
        'x-client-bundle-id': '',
        'x-client-platform': 'web',
        'x-client-version': meta.version,
        'x-client-locale': /^zh/i.test(meta.locale) ? 'zh_CN' : 'en_US',
        'x-client-timezone-offset': String(meta.timezoneOffsetSeconds),
        'user-agent': BROWSER_UA,
        accept: 'application/json, text/plain, */*',
        referer: `${grant.issuer}/`,
        origin: grant.issuer,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(12_000),
    })
    if (!response.ok) return { ok: false, reason: `http-${response.status}` }
    const body = await response.json()
    if (body?.code !== 0 || body?.data?.biz_code !== 0) return { ok: false, reason: 'platform-rejected' }
    const biz = body.data.biz_data ?? {}
    return { ok: true, via: 'direct', wallets: normalizeWallets(biz.normal_wallets), bonusWallets: normalizeWallets(biz.bonus_wallets) }
  } catch (error) {
    return { ok: false, reason: String(error).slice(0, 120) }
  }
}

// ------------------------------------------------------------------ transport

function send(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(text)
}

function query(req) {
  return new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
}

export function apply(ctx) {
  const db = openDatabase()
  let running = null
  let lastResult = null

  const runIngest = () => {
    if (running !== null) return running
    running = ingestAll(db)
      .then((result) => { lastResult = { ...result, at: Date.now() }; return result })
      .catch((error) => { lastResult = { error: String(error), at: Date.now() }; return null })
      .finally(() => { running = null })
    return running
  }

  const timer = setTimeout(() => { void runIngest() }, 1_500)
  const interval = setInterval(() => { void runIngest() }, SCAN_INTERVAL_MS)

  const routes = [
    {
      path: `${ROUTE}/status`,
      handler: (req, res) => {
        const totalsRow = db.prepare('SELECT COUNT(*) requests, COALESCE(SUM(cost_cny),0) cost FROM requests').get()
        const sessions = db.prepare('SELECT COUNT(*) c FROM sessions').get().c
        const prices = db.prepare('SELECT COUNT(*) c FROM prices').get().c
        const holidays = db.prepare('SELECT COUNT(*) c FROM holidays').get().c
        return send(res, 200, {
          ok: true,
          dbPath: defaultDbPath(),
          requests: totalsRow.requests,
          cost: totalsRow.cost,
          sessions,
          prices,
          holidays,
          ingesting: running !== null,
          last: lastResult,
        })
      },
    },
    {
      path: `${ROUTE}/summary`,
      handler: (req, res) => {
        const { from, to } = range(query(req))
        return send(res, 200, summary(db, from, to))
      },
    },
    {
      path: `${ROUTE}/models`,
      handler: (req, res) => {
        const { from, to } = range(query(req))
        return send(res, 200, modelBreakdown(db, from, to))
      },
    },
    {
      path: `${ROUTE}/sessions`,
      handler: (req, res) => {
        const params = query(req)
        const { from, to } = range(params)
        return send(res, 200, sessionBreakdown(db, from, to, limitOffset(params)))
      },
    },
    {
      path: `${ROUTE}/requests`,
      handler: (req, res) => {
        const params = query(req)
        const { from, to } = range(params)
        return send(res, 200, requestLog(db, from, to, limitOffset(params), {
          model: params.get('model') ?? undefined,
          session: params.get('session') ?? undefined,
        }))
      },
    },
    {
      path: `${ROUTE}/balance`,
      handler: async (req, res) => {
        const params = query(req)
        const meta = {
          version: params.get('v') ?? '0.0.0',
          locale: params.get('locale') ?? 'en',
          timezoneOffsetSeconds: Number(params.get('tz') ?? 0) || 0,
        }
        return send(res, 200, await accountBalance(ctx, meta))
      },
    },
    {
      path: `${ROUTE}/reindex`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
        db.exec('DELETE FROM ingest')
        const result = await runIngest()
        return send(res, 200, { ok: result !== null, result })
      },
    },
  ]

  const disposers = routes.map((route) => ctx.webServer.register({
    kind: 'exact',
    path: route.path,
    handler: route.handler,
  }))
  ctx.effect(() => () => {
    clearTimeout(timer)
    clearInterval(interval)
    for (const dispose of disposers) dispose()
    try { db.close() } catch { /* host is shutting down */ }
  })
}

// Exported for local verification scripts; the Cordis loader ignores extras.
export const testables = {
  openDatabase,
  defaultDbPath,
  ingestAll,
  summary,
  modelBreakdown,
  sessionBreakdown,
  requestLog,
  isPeak,
  shanghaiParts,
  costOf,
  listSessionFiles,
}
