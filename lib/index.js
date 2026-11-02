// dsh-diary / lib/index.js
// 阿尔法的账本：一件事一条记录、主题成网、能按主题和关键词翻回去。
// 原则：先落盘再结算；任何异常只 warn，绝不让插件拖垮宿主启动。

import { defineTool } from '@deepseek-ai/dsh-tools'
import { homedir } from 'node:os'
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, cpSync, unlinkSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

import {
  openDb, insertEntry, getMeta, setMeta, importLegacyJsonl,
  search, recentEntries, dayStats, dayKeyOf, findTopic, upsertTopic,
  entriesOfTopic, topicsOfEntry,
  entriesMissingVec, vecStats,
} from './db.js'
import {
  importanceOf, rankedTopics, preferenceSlots, matchTopics, ensurePinned,
} from './topics.js'
import { settle, sanitize, isSubstantive, journalTextFor, takeOf, addDetail } from './settle.js'
import { createEmbedder, indexEntry, vectorSearch, expandQuery } from './semantic.js'
import { ingestBili } from './bili.js'
import { ingestPet } from './pet.js'

export const name = 'diary'
export const Config = undefined
export const inject = ['tools', 'systemPrompt']

/** 启动自检：每一步都留痕，出问题能一眼看出停在哪。 */
let STEP_FILE = ''
function step(what, extra) {
  try {
    if (!STEP_FILE) return
    appendFileSync(STEP_FILE, JSON.stringify({ t: Date.now(), what, ...(extra ? { extra } : {}) }) + '\n', 'utf8')
  } catch {}
}

const DEFAULTS = {
  enabled: true,
  idleMs: 10 * 60 * 1000,        // 桌面：这么久没动静就算这段聊完了
  qqSettleAt: '23:50',           // QQ：每天一次
  journalAt: '23:58',            // 日记：每天一次
  autoJournal: true,
  semantic: true,
  hfEndpoint: 'https://hf-mirror.com',
  embedModel: 'Xenova/bge-small-zh-v1.5',
  injectTopicHint: true,
  hintOrder: 1500,
  publicChannels: ['qq'],        // 群聊算公开；私聊单独判
  ownerQQ: '',
  backupKeepDays: 7,
  backfillLimit: 300,            // 每次启动最多补多少条向量（0 = 不补）
  backfillDelayMs: 5000,
  catchupDays: 3,                // 启动/定时补跑：最近几天没结算的 QQ 与日记
  biliWatch: true,               // B站：把 whale-diary.md 的「看过」表收进账本
  biliWatchPath: '',             // 空 = ~/.dsh/whale-diary.md
  biliWatchMs: 5 * 60 * 1000,    // 多久看一次（按 BV 去重，重复跑没关系）
  petWatch: true,                // 桌面：把桌宠的聊天收进账本（dsh-pet 的 memory.json）
  petMemoryPath: '',             // 空 = ~/.dsh/dsh-pet/memory.json
  petWatchMs: 60 * 1000,         // 多久看一次（按 ref 去重）
  desktopFromSessions: false,    // 桌面通道只记桌宠的聊天；DSH 会话（写代码那种）不进账本
}

/**
 * 一段会话该算私事还是公开。
 * 规则：桌面 = 私事；B站 / QQ群 = 公开；QQ私聊只有对面是主人（ownerQQ）才算私事。
 * 没配 ownerQQ 时一律按公开——宁可少记私事，也不把陌生人的话写进私密账。
 */
export function visFor(sessionId, ownerQQ, explicitChannel) {
  const sid = String(sessionId || '')
  const owner = String(ownerQQ || '')
  if (explicitChannel === 'bili' || explicitChannel === 'qq-group') return 'public'
  if (/onebot/i.test(sid) && /group/i.test(sid)) return 'public'
  const ch = explicitChannel || (/(bili|whale)/i.test(sid) ? 'bili' : /onebot/i.test(sid) ? 'qq' : 'desktop')
  if (ch === 'bili' || ch === 'qq-group') return 'public'
  if (ch === 'qq') {
    const m = /private[:_-](\d+)/i.exec(sid)
    return m && owner && m[1] === owner ? 'private' : 'public'
  }
  return 'private'
}

/** 最近 n+1 个日期键（含今天），按本地时区，从旧到新。 */
export function dayKeysBack(n, todayKey) {
  const base = Date.parse(`${todayKey}T12:00:00`)
  const out = []
  for (let i = n; i >= 0; i--) {
    const d = new Date(base - i * 86_400_000)
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
  }
  return out
}

/**
 * 哪些天还欠着结算：lastSettled 之后、最近 catchupDays 天内。
 * 今天只有在过了 settleAt 之后才算欠着；过去的日子一过 0 点就欠着。
 */
export function dueSettleDays(lastSettled, todayKey, catchupDays = 3, nowHM = '00:00', settleAt = '23:50') {
  const last = String(lastSettled || '')
  const at = String(settleAt || '23:50')
  return dayKeysBack(catchupDays, todayKey).filter((day) => {
    if (last && day <= last) return false
    if (day === todayKey) return nowHM >= at
    return true
  })
}

export function apply(ctx, config) {
  try {
    return applyInner(ctx, config)
  } catch (err) {
    // 启动失败必须留证：宿主日志里看不到插件异常的细节。
    try {
      const p = join(homedir(), '.dsh', 'diary', 'fatal.json')
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, JSON.stringify({
        at: new Date().toISOString(),
        name: err?.name, message: err?.message,
        stack: String(err?.stack || '').split('\n').slice(0, 12),
        step: STEP_FILE,
      }, null, 2), 'utf8')
    } catch {}
    try { ctx?.logger?.warn?.(`[diary] 初始化失败，已跳过：${err?.message || err}`) } catch {}
    return undefined
  }
}

function applyInner(ctx, config) {
  const baseDir = (config && config.dir) || join(homedir(), '.dsh', 'diary')
  mkdirSync(baseDir, { recursive: true })
  const cfg = { ...DEFAULTS, ...(config || {}), ...loadConfig(baseDir) }
  const dir = cfg.dir || baseDir
  mkdirSync(dir, { recursive: true })
  STEP_FILE = join(dir, 'steps.jsonl')
  step('start', { dir })

  const db = openDb(dir)
  step('db-open')
  const logger = ctx?.logger || null
  let imported = 0
  try { imported = importLegacyJsonl(db, dir) } catch (err) { logger?.warn?.(`[diary] 旧账导入失败：${err?.message || err}`) }
  try { ensurePinned(db, upsertTopic) } catch {}

  const embedder = cfg.semantic ? createEmbedder({ model: cfg.embedModel, hfEndpoint: cfg.hfEndpoint, logger }) : null
  const buffers = new Map()   // sessionId -> { ch, vis, msgs[], lastAt }
  const sessionInfo = new Map() // sessionId -> { ch, vis }
  let topicHint = ''

  // 谁是主人：只有和主人的私聊算私事。来源 config.json / 调用参数，写进 meta 供工具侧判定。
  const ownerQQ = String(cfg.ownerQQ || getMeta(db, 'owner_qq', '') || '')
  if (ownerQQ) { try { setMeta(db, 'owner_qq', ownerQQ) } catch {} }
  else logger?.warn?.('[diary] 未配置 ownerQQ，QQ 私聊会按公开处理；在 config.json 里写 {"ownerQQ":"你的QQ号"} 可恢复私密。')

  /* ── 未结算消息落盘：进程中途没了，重启还能补回来 ── */
  const pendingPath = join(dir, 'pending.jsonl')
  const pendingKey = (sid, m) => `${sid}|${m.at}|${m.role}`
  function pendingAppend(sid, rec) {
    try { appendFileSync(pendingPath, JSON.stringify({ sid, ...rec }) + '\n', 'utf8') } catch {}
  }
  function pendingLoad() {
    try {
      if (!existsSync(pendingPath)) return []
      return readFileSync(pendingPath, 'utf8').split('\n').filter(Boolean)
        .map((line) => { try { return JSON.parse(line) } catch { return null } })
        .filter(Boolean)
    } catch { return [] }
  }
  function pendingDrop(keys) {
    if (!keys.length) return
    try {
      const drop = new Set(keys)
      const rest = pendingLoad().filter((r) => !drop.has(`${r.sid}|${r.at}|${r.role}`))
      writeFileSync(pendingPath, rest.map((r) => JSON.stringify(r)).join('\n') + (rest.length ? '\n' : ''), 'utf8')
    } catch (err) { logger?.warn?.(`[diary] 清理未结算消息失败：${err?.message || err}`) }
  }
  function restorePending() {
    const recs = pendingLoad()
    if (!recs.length) return 0
    let n = 0
    for (const r of recs) {
      const sid = String(r.sid || '')
      if (!sid || !r.text) continue
      if ((r.ch || 'desktop') === 'desktop' && !cfg.desktopFromSessions) continue
      const buf = buffers.get(sid) || { ch: r.ch || 'desktop', vis: r.vis || 'private', msgs: [], lastAt: r.at || Date.now(), header: null }
      buf.ch = r.ch || buf.ch
      buf.vis = r.vis || buf.vis
      buf.msgs.push({ role: r.role || 'user', text: String(r.text).slice(0, 4000), at: r.at || Date.now() })
      buf.lastAt = Math.max(buf.lastAt || 0, r.at || 0)
      buffers.set(sid, buf)
      n += 1
    }
    step('pending-restore', { n })
    if (n) logger?.info?.(`[diary] 恢复了 ${n} 条上次没结算的消息`)
    return n
  }
  restorePending()

  markApply(dir, { imported, semantic: !!embedder, dir, ownerQQ: !!ownerQQ })

  /* ── 补向量：老记录没有向量，启动后在后台慢慢补 ── */
  let backfilling = false
  async function backfillVectors(limit = 300) {
    if (!embedder || backfilling) return { ok: false, why: backfilling ? '正在补' : '语义未开' }
    backfilling = true
    const before = vecStats(db)
    let done = 0
    let failed = 0
    let lastError = null
    let failsInRun = 0
    try {
      while (done + failed < limit) {
        const rows = entriesMissingVec(db, Math.min(50, limit - done - failed))
        if (!rows.length) break
        for (const row of rows) {
          if (done + failed >= limit) break
          try {
            const ok = await indexEntry(embedder, db, row.id, `${row.gist} ${row.take || ''}`)
            if (ok) {
              done += 1
              failsInRun = 0
            } else {
              failed += 1
              failsInRun += 1
              lastError = lastError || '向量化返回空（模型没加载起来？）'
            }
          } catch (err) {
            failed += 1
            failsInRun += 1
            lastError = String(err?.message || err)
            logger?.warn?.(`[diary] 补向量失败 ${row.id}：${lastError}`)
          }
          if (failsInRun >= 5) break // 连着失败，模型多半没就绪，别空转
        }
        if (failsInRun >= 5 || done + failed >= limit) break
        await new Promise((r) => setTimeout(r, 200))
      }
    } finally {
      backfilling = false
      const after = vecStats(db)
      writeJson(join(dir, 'semantic.json'), { at: new Date().toISOString(), model: cfg.embedModel, before, after, added: done, failed, error: lastError })
      if (lastError) logger?.warn?.(`[diary] 补向量中断：${lastError}（成功 ${done}，失败 ${failed}）`)
    }
    return { ok: true, added: done, failed, error: lastError, ...vecStats(db) }
  }

  /* ── 认通道与可见性 ── */
  function channelOf(sessionId, header, kind) {
    const s = String(sessionId || '')
    const h = header || {}
    const blob = `${s} ${h.id || ''} ${h.cwd || ''} ${h.title || ''}`.toLowerCase()
    if (blob.includes('bili') || blob.includes('whale')) return 'bili'
    if (blob.includes('onebot')) {
      // onebot-private-<qq> 是私聊，onebot-group-… 是群
      if (s.includes('group')) return 'qq-group'
      return 'qq'
    }
    if (kind === 'speak-up') return 'desktop'
    if (blob.includes('vigil')) return 'desktop'
    return 'desktop'
  }

  function visOf(channel, sessionId) {
    return visFor(sessionId, ownerQQ, channel)
  }

  /* ── 采集 ── */
  const collect = (sessionId, header, role, text, at, kind) => {
    const sid = String(sessionId || '')
    if (!sid) return
    const ch = channelOf(sid, header, kind)
    // 桌面通道只收桌宠的聊天（见 pet.js）；写代码那种会话不进账本
    if (ch === 'desktop' && !cfg.desktopFromSessions) return
    const vis = visOf(ch, sid)
    sessionInfo.set(sid, { ch, vis })
    const buf = buffers.get(sid) || { ch, vis, msgs: [], lastAt: at, header }
    buf.ch = ch; buf.vis = vis; buf.lastAt = at; buf.header = header || buf.header
    if (text && text.trim()) {
      const m = { role, text: text.trim().slice(0, 4000), at }
      buf.msgs.push(m)
      pendingAppend(sid, { ch, vis, role: m.role, text: m.text, at })
    }
    if (buf.msgs.length > 400) {
      const dropped = buf.msgs.splice(0, buf.msgs.length - 400)
      pendingDrop(dropped.map((m) => pendingKey(sid, m)))
    }
    buffers.set(sid, buf)
  }

  function textOf(message) {
    const blocks = message?.content
    if (!Array.isArray(blocks)) return typeof blocks === 'string' ? blocks : ''
    return blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
  }

  const disposers = []

  disposers.push(ctx.effect(() => ctx.on('session/created', (session) => {
    try {
      const h = session?.header || {}
      const sid = String(session?.id || h.id || '')
      if (sid) sessionInfo.set(sid, { ch: channelOf(sid, h), vis: visOf(channelOf(sid, h), sid) })
    } catch {}
  }), 'diary:session'))

  disposers.push(ctx.effect(() => ctx.on('agent/inbox/claimed', ({ agent, message } = {}) => {
    try {
      const sid = agent?.session?.id || agent?.id || ''
      const header = agent?.session?.header || {}
      const text = textOf(message)
      if (!text) return

      // 主题提示：这一轮主人提到的东西，如果库里有，就挂到注入面
      try {
        const hits = matchTopics(db, text, 3)
        topicHint = hits.length ? renderTopicHint(hits, db) : ''
      } catch { topicHint = '' }

      collect(sid, header, 'user', text, Date.now(), message?.source?.kind)
    } catch (err) { logger?.warn?.(`[diary] 采集失败：${err?.message || err}`) }
  }), 'diary:inbox'))

  disposers.push(ctx.effect(() => ctx.on('session/event', (session, event) => {
    try {
      if (!event || event.type !== 'assistant/message') return
      const sid = String(session?.id || session?.header?.id || '')
      const text = textOf(event.data?.message)
      if (!text || /^\(empty\)$/.test(text)) return
      collect(sid, session?.header || {}, 'assistant', text, Date.now())
    } catch (err) { logger?.warn?.(`[diary] 记录回话失败：${err?.message || err}`) }
  }), 'diary:event'))

  disposers.push(ctx.effect(() => ctx.on('session/disposed', (session) => {
    try {
      const sid = String(session?.id || '')
      if (sid) { flush(sid, 'disposed'); buffers.delete(sid); sessionInfo.delete(sid) }
    } catch {}
  }), 'diary:disposed'))

  step('hooks')

  /* ── 结算 ── */
  function flush(sid, reason = 'idle') {
    const buf = buffers.get(sid)
    if (!buf || !buf.msgs.length) return []
    const consumed = buf.msgs.slice()
    const userMsgs = consumed.filter((m) => m.role === 'user' && isSubstantive(m.text))
    if (!userMsgs.length) { pendingDrop(consumed.map((m) => pendingKey(sid, m))); buffers.delete(sid); return [] }
    const written = settle({
      db, msgs: consumed, ch: buf.ch === 'qq-group' ? 'qq' : buf.ch,
      session: sid, vis: buf.vis, now: Date.now(),
      extractor: null, // 规则版：认不出主题就留空，不硬造
    })
    buffers.set(sid, { ...buf, msgs: [] })
    pendingDrop(consumed.map((m) => pendingKey(sid, m)))
    if (written.length) {
      appendJsonl(dir, written)
      indexWritten(written)
      logger?.info?.(`[diary] ${reason === 'idle' ? '空闲结算' : reason} 写入 ${written.length} 条`)
    }
    return written
  }

  function indexWritten(rows) {
    if (!embedder) return
    for (const r of rows) {
      const text = `${r.gist} ${r.take || ''}`.trim()
      if (!text) continue
      void indexEntry(embedder, db, r.id, text).catch(() => {})
    }
  }

  // 桌面：空闲看门狗
  disposers.push(ctx.effect(() => {
    const t = setInterval(() => {
      try {
        const now = Date.now()
        for (const [sid, buf] of buffers) {
          if (!buf.msgs.length) continue
          if (buf.ch !== 'desktop') continue
          if (now - buf.lastAt >= cfg.idleMs) flush(sid, 'idle')
        }
      } catch (err) { logger?.warn?.(`[diary] 空闲结算失败：${err?.message || err}`) }
    }, 30_000)
    t.unref?.()
    return () => clearInterval(t)
  }, 'diary:idle'))

  // QQ 日结 / 日记：每 30 秒看一眼有没有欠着的；错过 23:50 也会在下次启动补回来
  disposers.push(ctx.effect(() => {
    try { catchup('start') } catch (err) { logger?.warn?.(`[diary] 启动补跑失败：${err?.message || err}`) }
    const t = setInterval(() => {
      try { catchup('tick') } catch (err) { logger?.warn?.(`[diary] 定时任务失败：${err?.message || err}`) }
    }, 30_000)
    t.unref?.()
    return () => clearInterval(t)
  }, 'diary:tick'))

  // B站：每 5 分钟看一眼「看过」表，按 BV 去重，一个视频一条记录 + 一个主题
  const biliFile = cfg.biliWatchPath ? String(cfg.biliWatchPath) : join(homedir(), '.dsh', 'whale-diary.md')
  function watchBili(reason = 'tick') {
    if (!cfg.biliWatch) return 0
    const r = ingestBili({ db, file: biliFile, logger })
    if (r.added) {
      appendJsonl(dir, r.rows)
      indexWritten(r.rows)
      logger?.info?.(`[diary] B站入账 ${r.added} 个视频（${reason}）`)
    }
    return r.added
  }
  disposers.push(ctx.effect(() => {
    try { watchBili('start') } catch (err) { logger?.warn?.(`[diary] B站入账失败：${err?.message || err}`) }
    const t = setInterval(() => {
      try { watchBili('tick') } catch (err) { logger?.warn?.(`[diary] B站入账失败：${err?.message || err}`) }
    }, cfg.biliWatchMs)
    t.unref?.()
    return () => clearInterval(t)
  }, 'diary:bili'))
  step('bili')

  // 桌面：每 60 秒看一眼桌宠的聊天记录，一问一答 = 一条记录，按 ref 去重
  const petFile = cfg.petMemoryPath ? String(cfg.petMemoryPath) : join(homedir(), '.dsh', 'dsh-pet', 'memory.json')
  function watchPet(reason = 'tick') {
    if (!cfg.petWatch) return 0
    const r = ingestPet({ db, file: petFile, logger })
    if (r.added) {
      appendJsonl(dir, r.rows)
      indexWritten(r.rows)
      logger?.info?.(`[diary] 桌宠聊天入账 ${r.added} 条（${reason}）`)
    }
    return r.added
  }
  disposers.push(ctx.effect(() => {
    try { watchPet('start') } catch (err) { logger?.warn?.(`[diary] 桌宠入账失败：${err?.message || err}`) }
    const t = setInterval(() => {
      try { watchPet('tick') } catch (err) { logger?.warn?.(`[diary] 桌宠入账失败：${err?.message || err}`) }
    }, cfg.petWatchMs)
    t.unref?.()
    return () => clearInterval(t)
  }, 'diary:pet'))
  step('pet')

  /** 结算某一天的 QQ 消息（消息可能来自这次启动的新缓冲，也可能是从 pending 恢复的旧消息）。 */
  function settleDay(day) {
    let n = 0
    for (const [sid, buf] of Array.from(buffers)) {
      if (buf.ch !== 'qq' && buf.ch !== 'qq-group') continue
      const marks = []
      buf.msgs.forEach((m, i) => { if (dayKeyOf(m.at) === day) marks.push(i) })
      if (!marks.length) continue
      // 取连续一段：同一天里用户消息和回话不能拆开配对
      const msgs = buf.msgs.slice(marks[0], marks[marks.length - 1] + 1)
      const userMsgs = msgs.filter((m) => m.role === 'user' && isSubstantive(m.text))
      if (userMsgs.length) {
        const written = settle({
          db, msgs, ch: buf.ch === 'qq-group' ? 'qq' : buf.ch,
          session: sid, vis: buf.vis, now: Date.now(), extractor: null,
        })
        if (written.length) {
          appendJsonl(dir, written)
          indexWritten(written)
          n += written.length
        }
      }
      pendingDrop(msgs.map((m) => pendingKey(sid, m)))
      const rest = buf.msgs.filter((m) => !msgs.includes(m))
      if (rest.length) buffers.set(sid, { ...buf, msgs: rest })
      else buffers.delete(sid)
    }
    if (n) logger?.info?.(`[diary] QQ 日结 ${day}：${n} 条`)
    return n
  }

  /** 补跑：把漏掉的 QQ 日结和日记补上，逻辑幂等，可每 30 秒跑一次。 */
  function catchup(reason = 'tick') {
    const now = new Date()
    const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    const today = dayKeyOf(now.getTime())
    let settled = 0
    for (const day of dueSettleDays(getMeta(db, 'qq_settled_day', ''), today, cfg.catchupDays, hm, cfg.qqSettleAt)) {
      settled += settleDay(day)
      setMeta(db, 'qq_settled_day', day)   // 没数据也推进，别天天重试同一天
    }
    if (cfg.autoJournal) {
      let wrote = 0
      for (const day of dayKeysBack(cfg.catchupDays, today)) {
        if (day === today && hm < cfg.journalAt) continue
        if (db.prepare('SELECT 1 FROM journal WHERE day = ?').get(day)) continue
        const text = buildJournal(day)
        if (!text) continue
        db.prepare('INSERT INTO journal(day, text, at, model) VALUES(?, ?, ?, ?) ON CONFLICT(day) DO UPDATE SET text = excluded.text, at = excluded.at')
          .run(day, text, Date.now(), 'rule')
        writeJournalFile(dir, day, text)
        setMeta(db, 'journal_day', day)
        wrote += 1
      }
      if (wrote) {
        if (reason === 'start') logger?.info?.(`[diary] 补齐 ${wrote} 天日记`)
        try { backupDb(dir, db, cfg.backupKeepDays) } catch {}
      }
    }
    return settled
  }

  function buildJournal(day, vis = null) {
    const st = vis ? dayStats(db, day, { vis }) : dayStats(db, day)
    if (!st.total) return ''
    const rows = vis
      ? db.prepare('SELECT * FROM entries WHERE day = ? AND vis = ? ORDER BY at ASC LIMIT 60').all(day, vis)
      : db.prepare('SELECT * FROM entries WHERE day = ? ORDER BY at ASC LIMIT 60').all(day)
    const byCh = Object.entries(st.byCh).map(([k, v]) => `${chName(k)} ${v}`).join(' · ')
    const lines = rows.map((r) => {
      const ts = topicsOfEntry(db, r.id).map((t) => t.name).join('、')
      return `- ${ts ? `【${ts}】` : ''}${r.gist}${r.take ? ` —— ${r.take}` : ''}`
    })
    return [
      `# ${day}`,
      '',
      `今天记下 ${st.total} 件事（${byCh}），平均重要度 ${st.avgImp.toFixed(2)}。`,
      '',
      ...lines,
    ].join('\n')
  }

  /* ── 注入面 ── */
  if (cfg.injectTopicHint) {
    try {
      disposers.push(ctx.effect(() => {
        const sp = ctx.systemPrompt
        if (!sp || typeof sp.section !== 'function') return () => {}
        const def = {
          name: 'diary:topic',
          order: cfg.hintOrder,
          text: () => topicHint || '',
        }
        const d = sp.section(def)
        return typeof d === 'function' ? d : () => {}
      }, 'diary:section'))
      step('section')
    } catch (err) {
      logger?.warn?.(`[diary] 主题提示注入失败（不影响记账）：${err?.message || err}`)
    }
  }

  /* ── 后台补向量（老记录、旧账导入的都没有） ── */
  if (embedder && cfg.backfillLimit > 0) {
    try {
      disposers.push(ctx.effect(() => {
        const t = setTimeout(() => { void backfillVectors(cfg.backfillLimit) }, Math.max(1000, cfg.backfillDelayMs || 5000))
        t.unref?.()
        return () => { try { clearTimeout(t) } catch {} }
      }, 'diary:backfill'))
    } catch (err) {
      logger?.warn?.(`[diary] 补向量定时器没挂上：${err?.message || err}`)
    }
  }

  /* ── 工具 ── */
  step('before-tools')
  const defineErrors = []
  const tools = buildTools({ db, cfg, dir, embedder, flush, buffers, logger, buildJournal, defineErrors, backfillVectors, ownerQQ })
  step('defined', { ok: tools.length, bad: defineErrors.length })
  const registered = []
  const failed = [...defineErrors]
  for (const tool of tools) {
    try {
      if (!ctx?.tools || typeof ctx.tools.register !== 'function') { failed.push({ name: tool.name, error: 'no tools service' }); continue }
      ctx.tools.register(tool)
      registered.push(tool.name)
    } catch (err) {
      failed.push({ name: tool.name, error: String(err?.message || err) })
    }
  }
  step('registered', { n: registered.length, failed: failed.length })
  writeJson(join(dir, 'register-ok.json'), {
    at: new Date().toISOString(), dir, registered, failed,
    semantic: !!embedder, imported, ownerQQ: !!ownerQQ,
  })
  step('done')
  // 启动成功就清掉上次的失败记录，免得把旧故障一直当成现况。
  try { const f = join(dir, 'fatal.json'); if (existsSync(f)) unlinkSync(f) } catch {}

  return () => { for (const d of disposers) { try { d?.() } catch {} } }
}

/* ───────────────────────────── 工具定义 ───────────────────────────── */

function buildTools({ db, cfg, dir, embedder, buildJournal, defineErrors = [], backfillVectors, ownerQQ }) {
  const out = []
  // defineTool 会因为 schema 不合规直接抛错；一个坏工具不该带崩整批注册。
  const T = (spec) => {
    try {
      return defineTool(spec)
    } catch (err) {
      defineErrors.push({ name: spec?.name || '(unnamed)', error: String(err?.message || err) })
      return null
    }
  }

  out.push(T({
    name: 'diary_search',
    description: '翻账本：按主题、关键词、时间找过去发生过的事。返回每条的一句话摘要和她当时的想法。',
    parameters: {
      query: { type: 'string', description: '关键词（可空）' },
      topics: { type: 'string', description: '主题名，多个用空格分隔（可空）' },
      days: { type: 'number', description: '往回几天，默认 30' },
      channel: { type: 'string', description: 'desktop / qq / bili（可空）' },
      limit: { type: 'number', description: '最多几条，默认 15' },
    },
    output: { schema: { type: 'string' }, render: (a, v) => [{ type: 'text', text: String(v) }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const days = Math.max(1, Number(args.days) || 30)
      const limit = Math.max(1, Math.min(100, Number(args.limit) || 15))
      const topicNames = String(args.topics || '').split(/\s+/).filter(Boolean)
      const vis = viewerVisOf(exec, db)
      const from = Date.now() - days * 86400_000

      let rows = search(db, { q: args.query || '', topics: topicNames, from, ch: args.channel || undefined, limit, vis })

      // 关键词没命中 → 改写扩词再试一次；还不行 → 向量召回
      if (!rows.length && args.query) {
        const extra = await expandQuery(args.query, { llmText: null })
        for (const w of extra) {
          rows = search(db, { q: w, topics: topicNames, from, ch: args.channel || undefined, limit, vis })
          if (rows.length) break
        }
      }
      if (!rows.length && args.query && embedder) {
        const hits = await vectorSearch(embedder, db, args.query, { limit })
        if (hits.length) {
          const ids = hits.map((h) => h.entryId)
          const ph = ids.map(() => '?').join(',')
          rows = db.prepare(`SELECT * FROM entries WHERE id IN (${ph})`).all(...ids)
            .filter((r) => vis !== 'public' || r.vis === 'public')
            .map((r) => ({ ...r, topics: topicsOfEntry(db, r.id) }))
        }
      }
      if (!rows.length) return '（翻不到。可能本来就没记，或者说法不一样。）'
      return rows.map((r) => renderRow(db, r)).join('\n')
    },
  }))

  out.push(T({
    name: 'diary_record',
    description: '现在这条值得记：写一句话摘要 + 你自己的想法 + 主题（没有就新建）。看视频、聊完一件正事都用它。',
    parameters: {
      gist: { type: 'string', required: true, description: '一句话：发生了什么（不写原话）' },
      take: { type: 'string', required: true, description: '你自己的想法，可以是「没什么感觉」，不能空' },
      topic: { type: 'string', description: '主题名，如 某游戏名 / AI 人格（可空）' },
      subtopic: { type: 'string', description: '小主题，如第几章（可空）' },
      channel: { type: 'string', description: 'desktop / qq / bili，默认按当前会话判' },
      kind: { type: 'string', description: 'chat / reply / watch / work / promise / mood，默认 chat' },
      importance: { type: 'number', description: '0~1，你自己觉得多重要' },
      detail: { type: 'string', description: '详细内容（长文、视频信息），会单独存一份（可空）' },
    },
    output: { schema: { type: 'string' }, render: (a, v) => [{ type: 'text', text: String(v) }] },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const sid = exec?.agent?.session?.id || exec?.agent?.id || ''
      const ch = args.channel || (String(sid).includes('bili') || String(sid).includes('whale') ? 'bili' : String(sid).includes('onebot') ? 'qq' : 'desktop')
      // 和采集侧用同一把尺子：只有主人私聊能写私事。
      const vis = visFor(sid, ownerQQ, ch)
      const row = insertEntry(db, {
        at: Date.now(), ch, kind: args.kind || 'chat',
        gist: sanitize(args.gist, 60), take: sanitize(args.take, 120),
        imp: Number(args.importance) || 0.3, vis, session: sid, source: 'manual',
      })
      let topicName = ''
      if (args.topic) {
        const t = upsertTopic(db, args.topic, {})
        if (t) {
          db.prepare('INSERT INTO entry_topics(entry_id, topic_id, weight) VALUES(?, ?, 1) ON CONFLICT(entry_id, topic_id) DO NOTHING').run(row.id, t.id)
          db.prepare('UPDATE topics SET hits = hits + 1, last_at = ? WHERE id = ?').run(Date.now(), t.id)
          topicName = t.name
        }
      }
      let detailId = ''
      if (args.detail) {
        detailId = addDetail(db, { entryId: row.id, kind: args.kind || 'note', title: args.gist, body: args.detail, at: row.at })
        db.prepare('UPDATE entries SET ref = ? WHERE id = ?').run(detailId, row.id)
      }
      if (embedder) void indexEntry(embedder, db, row.id, `${row.gist} ${row.take}`).catch(() => {})
      return `记下了${topicName ? `（主题：${topicName}）` : ''}：${row.gist}`
    },
  }))

  out.push(T({
    name: 'diary_day',
    description: '看今天记了些什么。',
    parameters: {},
    output: { schema: { type: 'string' }, render: (a, v) => [{ type: 'text', text: String(v) }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const vis = viewerVisOf(exec, db)
      const day = dayKeyOf(Date.now())
      const st = dayStats(db, day, { vis })
      if (!st.total) return `${day}：还没记下什么。`
      const rows = recentEntries(db, { days: 1, limit: 20, vis })
      return [`${day}：${st.total} 条`, ...rows.map((r) => renderRow(db, r))].join('\n')
    },
  }))

  out.push(T({
    name: 'diary_topic',
    description: '按主题查：这个主题聊过什么、我当时怎么想的、最近一次是什么时候。',
    parameters: { name: { type: 'string', required: true, description: '主题名' } },
    output: { schema: { type: 'string' }, render: (a, v) => [{ type: 'text', text: String(v) }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const vis = viewerVisOf(exec, db)
      const t = findTopic(db, args.name)
      if (!t) return `（还没有「${args.name}」这个主题。）`
      const rows = entriesOfTopic(db, t.id, 20).filter((r) => vis !== 'public' || r.vis === 'public')
      const sc = importanceOf(t)
      const head = `【${t.name}】${t.pinned ? '（置顶）' : ''} 聊过 ${t.hits} 次，重要度 ${sc.toFixed(2)}，最近 ${fmtAgo(t.last_at)}`
      if (!rows.length) return head + '\n（公开场合能看到的记录是空的。）'
      return [head, ...rows.map((r) => renderRow(db, r))].join('\n')
    },
  }))

  out.push(T({
    name: 'diary_topics',
    description: '主题榜：现在都有哪些主题、各多重要、B站 的 6 个位置会给谁。',
    parameters: {},
    output: { schema: { type: 'string' }, render: (a, v) => [{ type: 'text', text: String(v) }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const vis = viewerVisOf(exec, db)
      let ranked = rankedTopics(db).slice(0, 20)
      if (vis === 'public') {
        // 公开场合不暴露只在私事里出现过的主题名
        const hasPub = db.prepare("SELECT 1 FROM entry_topics et JOIN entries e ON e.id = et.entry_id WHERE et.topic_id = ? AND e.vis = 'public' LIMIT 1")
        ranked = ranked.filter((t) => t.pinned || hasPub.get(t.id))
      }
      if (!ranked.length) return '（还没有主题。）'
      let slots = preferenceSlots(db, { max: 6 })
      if (vis === 'public') slots = slots.filter((n) => ranked.some((t) => t.name === n))
      const lines = ranked.map((t) => `${t.pinned ? '★' : ' '} ${t.name} — ${t.score.toFixed(2)}（${t.hits} 次，${fmtAgo(t.last_at)}）`)
      return [...lines, '', `B站 六个位置：${slots.join(' / ')}`].join('\n')
    },
  }))

  out.push(T({
    name: 'diary_journal',
    description: '看某天的日记（汇总版）。不传日期就是今天。',
    parameters: { day: { type: 'string', description: 'YYYY-MM-DD，可空' } },
    output: { schema: { type: 'string' }, render: (a, v) => [{ type: 'text', text: String(v) }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const day = args.day || dayKeyOf(Date.now())
      const vis = viewerVisOf(exec, db)
      // 存下来的日记是私人版（含私事）；公开场合不能直接给，要现算一份只有 public 的。
      if (vis === 'public') return buildJournal(day, 'public') || `${day}：这天没记下什么。`
      const row = db.prepare('SELECT * FROM journal WHERE day = ?').get(day)
      if (row?.text) return row.text
      const text = buildJournal(day)
      return text || `${day}：这天没记下什么。`
    },
  }))

  out.push(T({
    name: 'diary_detail',
    description: '看某条记录的详细内容（比如某个视频的完整记录）。',
    parameters: { id: { type: 'string', required: true, description: '记录 id 或摘要里的片段' } },
    output: { schema: { type: 'string' }, render: (a, v) => [{ type: 'text', text: String(v) }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const key = String(args.id || '')
      const vis = viewerVisOf(exec, db)
      let row = db.prepare('SELECT * FROM entries WHERE id = ?').get(key)
      if (!row) {
        row = db.prepare(`SELECT * FROM entries WHERE gist LIKE ? ${vis === 'public' ? "AND vis = 'public'" : ''} ORDER BY at DESC LIMIT 1`).get(`%${key}%`)
      }
      if (!row) return '（找不到这条。）'
      if (vis === 'public' && row.vis !== 'public') return '（这条是私事，公开场合翻不到。）'
      const d = row.ref ? db.prepare('SELECT * FROM details WHERE id = ?').get(row.ref) : null
      if (!d) return `${row.gist}\n（这条没有更详细的记录。）`
      return `${row.gist}\n—— ${d.title}\n\n${d.body}`
    },
  }))

  out.push(T({
    name: 'diary_reindex',
    description: '给还没建向量的旧记录补向量（语义检索要用）。可以指定最多补多少条。',
    parameters: { limit: { type: 'number', description: '这次最多补多少条，默认 200' } },
    output: { schema: { type: 'string' }, render: (a, v) => [{ type: 'text', text: String(v) }] },
    isConcurrencySafe: () => false,
    async execute(args) {
      if (!embedder) return '（语义层没开，补不了向量。）'
      if (typeof backfillVectors !== 'function') return '（补向量的入口没接上。）'
      const limit = Math.max(1, Math.min(2000, Number(args?.limit) || 200))
      const r = await backfillVectors(limit)
      if (!r.ok) return `（没补成：${r.why}。）`
      if (r.failed) return `补了 ${r.added} 条，失败了 ${r.failed} 条（${r.error || '原因不明'}）。现在 ${r.done}/${r.total} 条有向量，还差 ${r.missing} 条。`
      return `补了 ${r.added} 条向量。现在 ${r.done}/${r.total} 条有向量${r.missing ? `，还差 ${r.missing} 条` : '，全齐了'}。`
    },
  }))

  return out.filter(Boolean)
}

/* ───────────────────────────── 渲染与杂务 ───────────────────────────── */

function renderRow(db, r) {
  const ts = topicsOfEntry(db, r.id).map((t) => t.name).join('、')
  const dt = fmtAgo(r.at)
  return `· ${dt}${ts ? `【${ts}】` : ''} ${r.gist}${r.take ? ` —— ${r.take}` : ''}`
}

function renderTopicHint(hits, db) {
  const lines = []
  for (const h of hits.slice(0, 2)) {
    const rows = entriesOfTopic(db, h.topic.id, 3)
    if (!rows.length) continue
    lines.push(`【这个我们聊过：${h.topic.name}】`)
    for (const r of rows) lines.push(`- ${fmtAgo(r.at)} ${r.gist}${r.take ? ` —— 我当时想：${r.take}` : ''}`)
  }
  return lines.join('\n')
}

function chName(ch) {
  return ch === 'qq' ? 'QQ'
    : ch === 'bili' ? 'B站'
      : ch === 'qq-group' ? 'QQ群'
        : ch === 'internal' ? '内部'
          : '桌面'
}

function fmtAgo(at) {
  if (!at) return '很久以前'
  const d = Date.now() - at
  if (d < 60_000) return '刚刚'
  if (d < 3600_000) return `${Math.floor(d / 60_000)} 分钟前`
  if (d < 86400_000) return `${Math.floor(d / 3600_000)} 小时前`
  const days = Math.floor(d / 86400_000)
  if (days < 30) return `${days} 天前`
  return dayKeyOf(at)
}

function viewerVisOf(exec, db) {
  const sid = String(exec?.agent?.session?.id || exec?.agent?.id || '')
  if (!sid) return null
  if (/(bili|whale)/i.test(sid)) return 'public'
  if (/onebot/i.test(sid)) {
    // 只有和主人的私聊能看全部；没配 ownerQQ 时谁的都是 public（不再默认放行）。
    const owner = getMeta(db, 'owner_qq', '')
    return visFor(sid, owner) === 'private' ? null : 'public'
  }
  return null // 桌面：自己人
}

function appendJsonl(dir, rows) {
  try {
    const day = dayKeyOf(Date.now())
    const file = join(dir, `${day}.jsonl`)
    const lines = rows.map((r) => JSON.stringify({
      at: r.at, kind: r.kind, ch: r.ch, gist: r.gist, take: r.take, imp: r.imp, vis: r.vis, id: r.id,
    })).join('\n') + '\n'
    const prev = existsSync(file) ? readFileSync(file, 'utf8') : ''
    writeFileSync(file, prev + lines, 'utf8')
  } catch {}
}

function writeJournalFile(dir, day, text) {
  try { writeFileSync(join(dir, `${day}.md`), text, 'utf8') } catch {}
}

function backupDb(dir, db, keepDays) {
  try {
    const bdir = join(dir, 'backup')
    mkdirSync(bdir, { recursive: true })
    const day = dayKeyOf(Date.now())
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } catch {}
    cpSync(join(dir, 'diary.db'), join(bdir, `diary-${day}.db`))
    const files = readdirSync(bdir).filter((f) => f.startsWith('diary-')).sort()
    while (files.length > Math.max(1, keepDays)) {
      const f = files.shift()
      try { unlinkSync(join(bdir, f)) } catch {}
    }
  } catch {}
}

function loadConfig(dir) {
  try {
    const p = join(dir, 'config.json')
    if (!existsSync(p)) return {}
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch { return {} }
}

function writeJson(path, obj) {
  try { writeFileSync(path, JSON.stringify(obj, null, 2), 'utf8') } catch {}
}

function markApply(dir, info) {
  writeJson(join(dir, 'apply.json'), { at: new Date().toISOString(), ...info })
}
