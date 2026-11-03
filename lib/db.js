// dsh-diary / lib/db.js
// SQLite 底座：一条记录 = 一件事；主题是多对多（DAG 的边落在 entry_topics 上）。
// 只用 node:sqlite（Node >= 22.5 内置），不引第三方依赖。

import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS entries (
  id         TEXT PRIMARY KEY,
  at         INTEGER NOT NULL,
  day        TEXT    NOT NULL,
  ch         TEXT    NOT NULL,
  kind       TEXT    NOT NULL,
  gist       TEXT    NOT NULL,
  take       TEXT    NOT NULL DEFAULT '',
  imp        REAL    NOT NULL DEFAULT 0.2,
  vis        TEXT    NOT NULL DEFAULT 'private',
  ref        TEXT,
  session    TEXT,
  source     TEXT    NOT NULL DEFAULT 'settle',
  take_src   TEXT    NOT NULL DEFAULT 'rule',
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS entries_day ON entries(day);
CREATE INDEX IF NOT EXISTS entries_ch  ON entries(ch);
CREATE INDEX IF NOT EXISTS entries_at  ON entries(at);

CREATE TABLE IF NOT EXISTS topics (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  aliases    TEXT NOT NULL DEFAULT '[]',
  pinned     INTEGER NOT NULL DEFAULT 0,
  mention    REAL NOT NULL DEFAULT 0,
  reaction   REAL NOT NULL DEFAULT 0,
  boost      REAL NOT NULL DEFAULT 0,
  hits       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER,
  last_at    INTEGER,
  note       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS topics_name ON topics(name);

CREATE TABLE IF NOT EXISTS entry_topics (
  entry_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  weight   REAL NOT NULL DEFAULT 1,
  PRIMARY KEY (entry_id, topic_id)
);
CREATE INDEX IF NOT EXISTS et_topic ON entry_topics(topic_id);

CREATE TABLE IF NOT EXISTS details (
  id       TEXT PRIMARY KEY,
  entry_id TEXT,
  kind     TEXT,
  title    TEXT NOT NULL DEFAULT '',
  body     TEXT NOT NULL DEFAULT '',
  meta     TEXT NOT NULL DEFAULT '{}',
  at       INTEGER
);
CREATE INDEX IF NOT EXISTS details_entry ON details(entry_id);

CREATE TABLE IF NOT EXISTS journal (
  day  TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  at   INTEGER,
  model TEXT
);

CREATE TABLE IF NOT EXISTS vec (
  entry_id TEXT PRIMARY KEY,
  dim      INTEGER NOT NULL,
  data     BLOB    NOT NULL,
  model    TEXT,
  at       INTEGER
);

CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
  entry_id UNINDEXED, body, tokenize = 'unicode61'
);
CREATE VIRTUAL TABLE IF NOT EXISTS details_fts USING fts5(
  entry_id UNINDEXED, body, tokenize = 'unicode61'
);
`

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const LATIN = /[A-Za-z0-9]/

/**
 * 把一段中文切成「单字 + 相邻 2-gram」，英文/数字按词切。
 * FTS5 的 unicode61 不会切中文，必须自己先切好再喂进去。
 */
export function bigram(text) {
  const s = String(text || '')
  const out = []
  let run = []
  let latin = ''
  const flushRun = () => {
    if (!run.length) return
    if (run.length === 1) out.push(run[0])
    for (let i = 0; i < run.length - 1; i++) out.push(run[i] + run[i + 1])
    run = []
  }
  const flushLatin = () => {
    if (latin) out.push(latin.toLowerCase())
    latin = ''
  }
  for (const ch of s) {
    if (CJK.test(ch)) { flushLatin(); run.push(ch) }
    else if (LATIN.test(ch)) { flushRun(); latin += ch }
    else { flushRun(); flushLatin() }
  }
  flushRun(); flushLatin()
  return out.join(' ')
}

export function openDb(dir) {
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'diary.db'))
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA busy_timeout = 3000')
  db.exec(SCHEMA)
  // 老库补列（0.1.9：take_src 记「想法」是模型写的还是规则截的）
  try {
    const cols = db.prepare('PRAGMA table_info(entries)').all().map((c) => c.name)
    if (!cols.includes('take_src')) db.exec("ALTER TABLE entries ADD COLUMN take_src TEXT NOT NULL DEFAULT 'rule'")
  } catch {}
  return db
}

export function getMeta(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
  return row ? row.value : fallback
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value))
}

/* ───────────────────────────── 记录 ───────────────────────────── */

export function insertEntry(db, e) {
  const at = Number(e.at) || Date.now()
  const row = {
    id: e.id || `e_${at.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    at,
    day: e.day || dayKeyOf(at),
    ch: e.ch || 'desktop',
    kind: e.kind || 'chat',
    gist: String(e.gist || '').trim() || '（没有留下话）',
    take: String(e.take || '').trim(),
    imp: clamp01(e.imp ?? 0.2),
    vis: e.vis === 'public' ? 'public' : 'private',
    ref: e.ref || null,
    session: e.session || null,
    source: e.source || 'settle',
    take_src: e.take_src === 'model' ? 'model' : 'rule',
    created_at: Date.now(),
  }
  db.prepare(`INSERT INTO entries(id, at, day, ch, kind, gist, take, imp, vis, ref, session, source, take_src, created_at)
              VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.id, row.at, row.day, row.ch, row.kind, row.gist, row.take, row.imp, row.vis, row.ref, row.session, row.source, row.take_src, row.created_at)
  reindexEntry(db, row)
  return row
}

export function reindexEntry(db, row) {
  db.prepare('DELETE FROM entries_fts WHERE entry_id = ?').run(row.id)
  db.prepare('INSERT INTO entries_fts(entry_id, body) VALUES(?, ?)')
    .run(row.id, bigram(`${row.gist} ${row.take}`))
}

export function insertDetail(db, d) {
  const id = d.id || `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  db.prepare('INSERT INTO details(id, entry_id, kind, title, body, meta, at) VALUES(?, ?, ?, ?, ?, ?, ?)')
    .run(id, d.entryId || null, d.kind || 'note', d.title || '', d.body || '', JSON.stringify(d.meta || {}), d.at || Date.now())
  db.prepare('DELETE FROM details_fts WHERE entry_id = ?').run(id)
  db.prepare('INSERT INTO details_fts(entry_id, body) VALUES(?, ?)')
    .run(id, bigram(`${d.title || ''} ${d.body || ''}`))
  return id
}

export function getDetail(db, id) {
  const row = db.prepare('SELECT * FROM details WHERE id = ?').get(id)
  if (!row) return null
  let meta = {}
  try { meta = JSON.parse(row.meta || '{}') } catch {}
  return { ...row, meta }
}

/* ───────────────────────────── 主题 ───────────────────────────── */

export function upsertTopic(db, name, opts = {}) {
  const clean = normalizeName(name)
  if (!clean) return null
  const now = Date.now()
  const found = findTopic(db, clean)
  if (found) {
    if (opts.pinned) db.prepare('UPDATE topics SET pinned = 1 WHERE id = ?').run(found.id)
    if (opts.aliases) addAliases(db, found.id, opts.aliases)
    db.prepare('UPDATE topics SET last_at = ? WHERE id = ?').run(now, found.id)
    return { ...found, created: false }
  }
  const id = `t_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`
  db.prepare('INSERT INTO topics(id, name, aliases, pinned, created_at, last_at, note) VALUES(?, ?, ?, ?, ?, ?, ?)')
    .run(id, clean, JSON.stringify(normalizeAliases(opts.aliases)), opts.pinned ? 1 : 0, now, now, opts.note || null)
  return { id, name: clean, pinned: opts.pinned ? 1 : 0, created: true }
}

export function findTopic(db, name) {
  const clean = normalizeName(name)
  if (!clean) return null
  const exact = db.prepare('SELECT * FROM topics WHERE name = ?').get(clean)
  if (exact) return hydrateTopic(exact)
  const rows = db.prepare('SELECT * FROM topics').all()
  const lower = clean.toLowerCase()
  for (const row of rows) {
    const t = hydrateTopic(row)
    if (t.name.toLowerCase() === lower) return t
    if (t.aliases.some((a) => a.toLowerCase() === lower)) return t
  }
  return null
}

export function hydrateTopic(row) {
  if (!row) return null
  let aliases = []
  try { aliases = JSON.parse(row.aliases || '[]') } catch {}
  return { ...row, aliases }
}

export function addAliases(db, topicId, aliases) {
  const row = db.prepare('SELECT aliases FROM topics WHERE id = ?').get(topicId)
  if (!row) return
  let cur = []
  try { cur = JSON.parse(row.aliases || '[]') } catch {}
  const merged = Array.from(new Set([...cur, ...normalizeAliases(aliases)]))
  db.prepare('UPDATE topics SET aliases = ? WHERE id = ?').run(JSON.stringify(merged), topicId)
}

export function listTopics(db, { pinnedFirst = true } = {}) {
  const rows = db.prepare('SELECT * FROM topics').all().map(hydrateTopic)
  rows.sort((a, b) => {
    if (pinnedFirst && a.pinned !== b.pinned) return b.pinned - a.pinned
    return b.hits - a.hits || (b.last_at || 0) - (a.last_at || 0)
  })
  return rows
}

export function linkEntryTopic(db, entryId, topicId, weight = 1) {
  db.prepare('INSERT INTO entry_topics(entry_id, topic_id, weight) VALUES(?, ?, ?) ON CONFLICT(entry_id, topic_id) DO UPDATE SET weight = excluded.weight')
    .run(entryId, topicId, weight)
  db.prepare('UPDATE topics SET hits = hits + 1, last_at = ? WHERE id = ?').run(Date.now(), topicId)
}

export function topicsOfEntry(db, entryId) {
  return db.prepare('SELECT t.* FROM topics t JOIN entry_topics et ON et.topic_id = t.id WHERE et.entry_id = ?')
    .all(entryId).map(hydrateTopic)
}

export function entriesOfTopic(db, topicId, limit = 20) {
  return db.prepare(`SELECT e.* FROM entries e JOIN entry_topics et ON et.entry_id = e.id
                     WHERE et.topic_id = ? ORDER BY e.at DESC LIMIT ?`).all(topicId, limit)
}

export function touchTopicStats(db, topicId, { mention = 0, reaction = 0, boost = 0 } = {}) {
  db.prepare('UPDATE topics SET mention = min(1.0, mention + ?), reaction = min(1.0, reaction + ?), boost = min(0.4, boost + ?) WHERE id = ?')
    .run(mention, reaction, boost, topicId)
}

/** 主题合并：src 并进 dst，边和别名一起搬走。 */
export function mergeTopics(db, srcId, dstId) {
  if (srcId === dstId) return
  const src = hydrateTopic(db.prepare('SELECT * FROM topics WHERE id = ?').get(srcId))
  const dst = hydrateTopic(db.prepare('SELECT * FROM topics WHERE id = ?').get(dstId))
  if (!src || !dst) return
  const rows = db.prepare('SELECT entry_id, weight FROM entry_topics WHERE topic_id = ?').all(srcId)
  for (const r of rows) linkEntryTopic(db, r.entry_id, dstId, r.weight)
  db.prepare('DELETE FROM entry_topics WHERE topic_id = ?').run(srcId)
  addAliases(db, dstId, [src.name, ...src.aliases])
  db.prepare('UPDATE topics SET hits = hits + ?, mention = max(mention, ?), reaction = max(reaction, ?) WHERE id = ?')
    .run(src.hits, src.mention, src.reaction, dstId)
  db.prepare('DELETE FROM topics WHERE id = ?').run(srcId)
}

/* ───────────────────────────── 检索 ───────────────────────────── */

export function search(db, opts = {}) {
  const limit = Math.max(1, Math.min(200, opts.limit || 20))
  const topics = (opts.topics || []).map((t) => (typeof t === 'string' ? findTopic(db, t) : t)).filter(Boolean)
  const where = []
  const args = []
  let sql

  if (topics.length) {
    const ph = topics.map(() => '?').join(',')
    sql = `SELECT e.*, (SELECT count(*) FROM entry_topics et2 WHERE et2.entry_id = e.id AND et2.topic_id IN (${ph})) AS hits
           FROM entries e JOIN entry_topics et ON et.entry_id = e.id
           WHERE et.topic_id IN (${ph})`
    args.push(...topics.map((t) => t.id), ...topics.map((t) => t.id))
  } else {
    sql = 'SELECT e.*, 0 AS hits FROM entries e WHERE 1 = 1'
  }

  if (opts.q) {
    const q = bigram(opts.q)
    if (q) {
      sql += ' AND e.id IN (SELECT entry_id FROM entries_fts WHERE entries_fts MATCH ?)'
      args.push(q)
    }
  }
  if (opts.ch) { sql += ' AND e.ch = ?'; args.push(opts.ch) }
  if (opts.kind) { sql += ' AND e.kind = ?'; args.push(opts.kind) }
  if (opts.vis === 'public') { sql += " AND e.vis = 'public'" }
  if (opts.from) { sql += ' AND e.at >= ?'; args.push(opts.from) }
  if (opts.to) { sql += ' AND e.at <= ?'; args.push(opts.to) }
  sql += ' GROUP BY e.id ORDER BY hits DESC, e.at DESC LIMIT ?'
  args.push(limit)

  let rows
  try { rows = db.prepare(sql).all(...args) } catch { rows = [] }
  return rows.map((r) => ({ ...r, topics: topicsOfEntry(db, r.id) }))
}

export function recentEntries(db, { days = 3, limit = 30, vis = null } = {}) {
  const from = Date.now() - days * 86400_000
  const args = [from]
  let sql = 'SELECT * FROM entries WHERE at >= ?'
  if (vis === 'public') sql += " AND vis = 'public'"
  sql += ' ORDER BY at DESC LIMIT ?'
  args.push(Math.max(1, Math.min(500, limit)))
  return db.prepare(sql).all(...args)
}

export function dayStats(db, day, { vis = null } = {}) {
  let sql = 'SELECT kind, ch, count(*) AS n, avg(imp) AS imp FROM entries WHERE day = ?'
  if (vis === 'public') sql += " AND vis = 'public'"
  sql += ' GROUP BY kind, ch'
  const rows = db.prepare(sql).all(day)
  let total = 0, imp = 0
  const byKind = {}, byCh = {}
  for (const r of rows) {
    total += r.n; imp += (r.imp || 0) * r.n
    byKind[r.kind] = (byKind[r.kind] || 0) + r.n
    byCh[r.ch] = (byCh[r.ch] || 0) + r.n
  }
  return { day, total, avgImp: total ? imp / total : 0, byKind, byCh }
}

/* ───────────────────────────── 向量 ───────────────────────────── */

export function putVec(db, entryId, vec, model) {
  const f = Float32Array.from(vec)
  db.prepare('INSERT INTO vec(entry_id, dim, data, model, at) VALUES(?, ?, ?, ?, ?) ON CONFLICT(entry_id) DO UPDATE SET dim = excluded.dim, data = excluded.data, model = excluded.model, at = excluded.at')
    .run(entryId, f.length, Buffer.from(f.buffer), model || 'unknown', Date.now())
}

export function allVecs(db) {
  return db.prepare('SELECT entry_id, dim, data FROM vec').all().map((r) => ({
    entryId: r.entry_id,
    vec: new Float32Array(new Uint8Array(r.data).buffer.slice(0)),
    dim: r.dim,
  }))
}

/** 还没建向量的记录（老数据、旧账本导入的都在这）。新的排前面，补起来更有用。 */
export function entriesMissingVec(db, limit = 200) {
  const n = Math.max(1, Math.min(2000, Number(limit) || 200))
  return db.prepare(`SELECT e.id, e.gist, e.take, e.at FROM entries e
                     LEFT JOIN vec v ON v.entry_id = e.id
                     WHERE v.entry_id IS NULL
                     ORDER BY e.at DESC LIMIT ?`).all(n)
}

/** 向量覆盖率，给工具和状态文件看。 */
export function vecStats(db) {
  const total = db.prepare('SELECT COUNT(*) c FROM entries').get().c || 0
  const done = db.prepare('SELECT COUNT(*) c FROM vec').get().c || 0
  return { total, done, missing: Math.max(0, total - done) }
}

/* ───────────────────────────── 旧账导入 ───────────────────────────── */

/** 把 bond 以前写的 diary/<日期>.jsonl 收进库，只做一次。 */
export function importLegacyJsonl(db, dir) {
  if (getMeta(db, 'legacy_imported') === '1') return 0
  let files = []
  try { files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) } catch { return 0 }
  let n = 0
  for (const f of files) {
    let text = ''
    try { text = readFileSync(join(dir, f), 'utf8') } catch { continue }
    for (const line of text.split('\n')) {
      const s = line.trim()
      if (!s) continue
      let e
      try { e = JSON.parse(s) } catch { continue }
      if (!e || !e.at || !e.gist) continue
      const dup = db.prepare('SELECT id FROM entries WHERE at = ? AND gist = ?').get(e.at, e.gist)
      if (dup) continue
      insertEntry(db, {
        at: e.at, day: e.day || dayKeyOf(e.at), ch: e.ch || 'desktop', kind: e.kind || 'chat',
        gist: e.gist, take: '', imp: e.imp ?? 0.2, vis: e.vis || 'private', source: 'legacy',
      })
      n++
    }
  }
  setMeta(db, 'legacy_imported', '1')
  return n
}

/* ───────────────────────────── 小工具 ───────────────────────────── */

export function dayKeyOf(ms) {
  const d = new Date(Number(ms) || Date.now())
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function clamp01(x) {
  const n = Number(x)
  if (!Number.isFinite(n)) return 0
  return n < 0 ? 0 : n > 1 ? 1 : n
}

export function normalizeName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40)
}

function normalizeAliases(list) {
  const arr = Array.isArray(list) ? list : list ? [list] : []
  return arr.map((a) => String(a || '').trim()).filter(Boolean).slice(0, 12)
}

export function dbFileExists(dir) {
  return existsSync(join(dir, 'diary.db'))
}
