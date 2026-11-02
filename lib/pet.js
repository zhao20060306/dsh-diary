// dsh-diary / lib/pet.js
// 桌宠聊天入账。
//
// 桌宠（dsh-pet）的对话不走 DSH 的会话，直接调模型，所以 agent/inbox 那些钩子看不见它。
// 它把自己的聊天记在 ~/.dsh/dsh-pet/memory.json 里：
//   { "<宠物id>": { "<对话id>": { "messages": [{ role, content, ts }, …] } } }
// 这里把它读出来，一问一答 = 一条记录。按 ref 去重，重复轮询不会写两遍。

import { existsSync, readFileSync } from 'node:fs'

import { insertEntry, insertDetail, upsertTopic, linkEntryTopic } from './db.js'
import { matchTopics } from './topics.js'
import { sanitize, isSubstantive, takeOf } from './settle.js'

// 情绪词：这类对话记成 mood，翻的时候好认
const MOOD_RE = /难过|委屈|生气|好烦|烦死|好累|累死|开心|高兴|喜欢|讨厌|害怕|焦虑|孤单|想你|呜呜|哈哈哈/

/**
 * 解析 dsh-pet 的 memory.json 文本，给出「一问一答」列表。
 * 一条记录 = 一句 user 话 + 它后面紧跟的 assistant 回话（直到下一句 user 为止）。
 */
export function parsePetMemory(text) {
  let obj
  try { obj = JSON.parse(text) } catch { return [] }
  if (!obj || typeof obj !== 'object') return []

  const out = []
  for (const [petId, convs] of Object.entries(obj)) {
    if (!convs || typeof convs !== 'object') continue
    for (const [convId, conv] of Object.entries(convs)) {
      const msgs = Array.isArray(conv?.messages) ? conv.messages : []
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i]
        if (!m || m.role !== 'user' || typeof m.content !== 'string' || !m.content.trim()) continue
        let reply = ''
        for (let j = i + 1; j < msgs.length && msgs[j]?.role !== 'user'; j++) {
          if (msgs[j]?.role === 'assistant' && typeof msgs[j].content === 'string') reply += msgs[j].content
        }
        const at = Number(m.ts) || 0
        out.push({
          ref: `pet:${petId}/${convId}/${at}`,
          pet: petId,
          conv: convId,
          user: m.content.trim(),
          reply: reply.trim(),
          at,
        })
      }
    }
  }
  return out
}

/**
 * 把 memory.json 里还没进账的桌宠聊天写进账本。
 * 返回 { total, added, rows }；rows 是新增条目，调用方负责写 jsonl / 建向量。
 */
export function ingestPet({ db, file, now = Date.now(), logger = null } = {}) {
  if (!file || !existsSync(file)) return { total: 0, added: 0, rows: [], missing: true }

  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    logger?.warn?.(`[diary] 读不了桌宠记忆 ${file}：${err?.message || err}`)
    return { total: 0, added: 0, rows: [], error: String(err?.message || err) }
  }

  const pairs = parsePetMemory(text)
  const rows = []
  const seen = new Set()
  for (const p of pairs) {
    if (seen.has(p.ref)) continue
    seen.add(p.ref)
    if (!isSubstantive(p.user)) continue           // 寒暄不记账
    if (db.prepare('SELECT 1 FROM entries WHERE ref = ?').get(p.ref)) continue

    const at = p.at || now
    const take = takeOf(p.reply || '')             // 她自己的话必须有：没回也给一句实话
    const kind = MOOD_RE.test(`${p.user} ${p.reply}`) ? 'mood' : 'chat'
    const gist = sanitize(p.user, 40)

    const entry = insertEntry(db, {
      at,
      ch: 'desktop',
      kind,
      vis: 'private',
      gist,
      take,
      imp: p.reply.length > 60 ? 0.3 : 0.25,
      ref: p.ref,
      session: `pet-${p.pet}`,
      source: 'pet',
    })
    rows.push(entry)

    try {
      const names = new Set(matchTopics(db, `${p.user} ${p.reply}`.slice(0, 400), 2).map((h) => h.topic.name))
      for (const name of names) {
        const topic = upsertTopic(db, name)
        if (topic) linkEntryTopic(db, entry.id, topic.id)
      }
    } catch (err) {
      logger?.warn?.(`[diary] 桌宠主题挂载失败 ${p.ref}：${err?.message || err}`)
    }

    try {
      insertDetail(db, {
        entryId: entry.id,
        kind: 'chat',
        title: gist,
        body: `他说：${p.user}\n\n我说：${p.reply || '（没回）'}`,
        meta: { pet: p.pet, conv: p.conv, ref: p.ref },
        at,
      })
    } catch (err) {
      logger?.warn?.(`[diary] 桌宠详情写入失败 ${p.ref}：${err?.message || err}`)
    }
  }

  if (rows.length) logger?.info?.(`[diary] 桌宠聊天入账 ${rows.length} 条`)
  return { total: pairs.length, added: rows.length, rows }
}
