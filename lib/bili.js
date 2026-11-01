// dsh-diary / lib/bili.js
// B站 那一路：从 ~/.dsh/whale-diary.md 的「看过」表里把视频收进账本。
// 一个视频 = 一条记录 + 一个主题；按 BV 去重，重复跑不会重复记。

import { existsSync, readFileSync } from 'node:fs'

import { insertDetail, insertEntry, linkEntryTopic, upsertTopic } from './db.js'
import { matchTopics } from './topics.js'

const BV_RE = /^BV[0-9A-Za-z]{10}$/

/** `2026-11-02 02:40` / `2026/11/2` 这类时间，按本地时区解析；认不出就给 fallback。 */
export function parseBiliTime(text, fallback = Date.now()) {
  const m = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(String(text || ''))
  if (!m) return fallback
  const d = new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    m[4] ? Number(m[4]) : 0, m[5] ? Number(m[5]) : 0,
  )
  const t = d.getTime()
  return Number.isFinite(t) ? t : fallback
}

/**
 * 从 `## 看过` 表格里抠出一行一个视频。
 * 按表头找列（时间 / BV / 标题 / 简介 / 想法 / UP），不依赖列顺序；表头缺失时按位置兜底。
 */
export function parseWatched(text) {
  const lines = String(text || '').split(/\r?\n/)
  const out = []
  let active = false
  let header = null
  let seenHeader = false
  const isRule = (cells) => cells.every((c) => c === '' || /^:?-{2,}:?$/.test(c))

  for (const raw of lines) {
    const line = raw.trim()
    const heading = /^#{1,6}\s*(.*)$/.exec(line)
    if (heading) {
      active = /看过/.test(heading[1])
      header = null
      seenHeader = false
      continue
    }
    if (!active) continue
    if (!line.startsWith('|')) {
      if (seenHeader) break // 表格结束
      continue
    }
    const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
    if (!seenHeader) {
      if (isRule(cells)) continue
      header = cells
      seenHeader = true
      continue
    }
    if (isRule(cells)) continue

    const pick = (...names) => {
      for (const n of names) {
        const i = header.findIndex((h) => h.toLowerCase().includes(n.toLowerCase()))
        if (i >= 0) {
          const v = cells[i]
          if (v) return v
        }
      }
      return ''
    }
    const bv = (pick('BV', 'bv') || cells[1] || '').trim()
    if (!BV_RE.test(bv)) continue
    const title = (pick('标题', 'title') || cells[2] || '').trim()
    const up = pick('UP', 'up', '作者') && pick('UP', 'up', '作者') !== title ? pick('UP', 'up', '作者') : ''
    let thought = pick('想法', 'thought', '感想')
    if (!thought && header.some((h) => h.includes('简介'))) {
      // 旧表是 | 时间 | BV | 标题 | 简介 | 想法 |：想法在最后一列
      thought = cells[cells.length - 1] || ''
    }
    const atText = pick('时间', 'time') || cells[0] || ''
    out.push({ bv, title, up, thought: thought.trim(), atText, atMs: parseBiliTime(atText) })
  }
  return out
}

/**
 * 从视频标题猜「所属作品 / 系列名」：优先书名号，其次方括号，再退回标题第一段。
 * 猜不到就返回空串（宁可不建主题，也不新建一堆垃圾主题）。
 */
export function topicFromTitle(title) {
  let s = String(title || '').trim()
  if (!s) return ''

  const book = /[《「『]([^》」』]{2,20})[》」』]/.exec(s)
  if (book) return book[1].trim()

  const bracket = /【([^】]{2,20})】/.exec(s)
  if (bracket) return bracket[1].trim()

  s = s.replace(/^[\p{Extended_Pictographic}\s【\[「『"'“]+/u, '')
  const first = s.split(/[|｜]/)[0].split(/[—–\-:：]/)[0].trim()
  const cut = first.length > 18 ? first.slice(0, 18) : first
  return cut.length >= 2 ? cut : ''
}

/**
 * 把「看过」表里还没进账的视频写进账本。
 * 返回 { total, added, rows }；rows 是新增条目，调用方负责写 jsonl / 建向量。
 */
export function ingestBili({ db, file, now = Date.now(), logger = null }) {
  if (!file || !existsSync(file)) return { total: 0, added: 0, rows: [], missing: true }
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    logger?.warn?.(`[diary] 读不了 B站 日记 ${file}：${err?.message || err}`)
    return { total: 0, added: 0, rows: [], error: String(err?.message || err) }
  }

  const videos = parseWatched(text)
  const rows = []
  const seen = new Set()
  for (const v of videos) {
    const ref = `bili:${v.bv}`
    if (seen.has(ref)) continue
    seen.add(ref)
    if (db.prepare('SELECT 1 FROM entries WHERE ref = ?').get(ref)) continue

    const at = v.atMs || now
    const title = v.title || v.bv
    const thought = String(v.thought || '').trim().slice(0, 200)
    const entry = insertEntry(db, {
      at,
      ch: 'bili',
      kind: 'watch',
      vis: 'public',
      gist: `看了《${title.slice(0, 60)}》`,
      // 她自己的话必须有：没写就老实说没写，不替她编
      take: thought || '看完了，没写下什么想法。',
      imp: 0.45,
      ref,
      session: 'bili-whale',
      source: 'bili',
    })

    // 主题：先认已有的，认不出来再从标题里猜一个系列名
    const names = new Set(matchTopics(db, `${title} ${thought}`, 3).map((h) => h.topic.name))
    const derived = topicFromTitle(title)
    if (derived) names.add(derived)
    for (const name of names) {
      const topic = upsertTopic(db, name)
      if (topic) linkEntryTopic(db, entry.id, topic.id)
    }

    const body = [
      `BV：${v.bv}`,
      `标题：${title}`,
      v.up ? `UP：${v.up}` : '',
      v.atText ? `看过时间：${v.atText}` : '',
      thought ? `她的想法：${thought}` : '她的想法：（没写）',
    ].filter(Boolean).join('\n')
    insertDetail(db, {
      entryId: entry.id,
      kind: 'video',
      title: `《${title}》 ${v.bv}`,
      body,
      meta: { bv: v.bv, title, up: v.up || null, at, url: `https://www.bilibili.com/video/${v.bv}` },
      at,
    })

    rows.push(entry)
  }
  return { total: videos.length, added: rows.length, rows }
}
