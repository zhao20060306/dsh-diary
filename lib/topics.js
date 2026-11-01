// dsh-diary / lib/topics.js
// 主题的重要度怎么算、怎么排序、怎么从一句话里认出来。

import { findTopic, listTopics, normalizeName, clamp01 } from './db.js'

/** 永远排第一、不参与竞争的那个。 */
export const PINNED_TOPIC = {
  name: 'AI 人格',
  aliases: ['AI人格', '虚拟伴侣', 'AI 陪伴', 'AI陪伴', '人格', '桌宠', '人设', '记忆', '阿尔法'],
}

/** 等权衰减：7 天内线性给到 0.35，之后归零。 */
export function freshOf(lastAt, now = Date.now()) {
  if (!lastAt) return 0
  const days = (now - lastAt) / 86400_000
  if (days < 0) return 0
  if (days >= 7) return 0
  return 0.35 * (1 - days / 7)
}

/**
 * 重要度 = 底座 + 提得多的 + 你反应热的 + 新鲜 + 她自评加权。
 * pinned 直接 1.00，不参与这个公式。
 */
export function importanceOf(t, now = Date.now()) {
  if (!t) return 0
  if (t.pinned) return 1
  const mention = clamp01(t.mention) * 0.55
  const reaction = clamp01(t.reaction) * 0.3
  const fresh = freshOf(t.last_at, now)
  const boost = Math.min(0.4, Math.max(0, Number(t.boost) || 0))
  return clamp01(0.15 + mention + reaction + fresh + boost)
}

export function rankedTopics(db, now = Date.now()) {
  return listTopics(db).map((t) => ({ ...t, score: importanceOf(t, now) }))
    .sort((a, b) => b.score - a.score || (b.last_at || 0) - (a.last_at || 0))
}

/** B站 检索词只有 6 个位置：pinned 占第一个，其余按分数竞争。 */
export function preferenceSlots(db, { max = 6, seeds = [], explicit = [] } = {}) {
  const ranked = rankedTopics(db)
  const locked = new Set(explicit.map((s) => String(s).toLowerCase()))
  const out = []
  const pinned = ranked.find((t) => t.pinned)
  if (pinned) out.push(pinned.name)
  for (const s of explicit) {
    if (out.length >= max) break
    if (!out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s)
  }
  for (const t of ranked) {
    if (out.length >= max) break
    if (t.pinned) continue
    if (locked.has(t.name.toLowerCase())) continue
    out.push(t.name)
  }
  for (const s of seeds) {
    if (out.length >= max) break
    if (locked.has(String(s).toLowerCase())) continue
    if (!out.some((x) => x.toLowerCase() === String(s).toLowerCase())) out.push(s)
  }
  return out.slice(0, max)
}

/** 从一句话里认出已经存在的主题（名字或别名被提到）。长的先匹配，避免「原神」吃掉「原神四」。 */
export function matchTopics(db, text, limit = 5) {
  const s = String(text || '')
  if (!s) return []
  const hits = []
  for (const t of listTopics(db)) {
    const keys = [t.name, ...(t.aliases || [])].filter(Boolean)
    let best = null
    for (const k of keys) {
      if (k.length < 2) continue
      if (s.toLowerCase().includes(k.toLowerCase())) {
        if (!best || k.length > best.length) best = k
      }
    }
    if (best) hits.push({ topic: t, matched: best })
  }
  hits.sort((a, b) => b.matched.length - a.matched.length)
  return hits.slice(0, limit)
}

/** 找「看起来是同一个东西」的主题对，给合并用。只建议，不自动合。 */
export function mergeCandidates(db) {
  const list = listTopics(db)
  const pairs = []
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i].name, b = list[j].name
      const la = a.toLowerCase(), lb = b.toLowerCase()
      if (la === lb) { pairs.push({ keep: list[i], drop: list[j], why: '同名' }); continue }
      if (la.includes(lb) || lb.includes(la)) {
        const keep = la.length >= lb.length ? list[i] : list[j]
        const drop = keep === list[i] ? list[j] : list[i]
        pairs.push({ keep, drop, why: '一个名字包含另一个' })
      }
    }
  }
  return pairs
}

/** 把模型给的「主题名 + 别名」规整一遍。 */
export function cleanTopicSpec(spec) {
  if (!spec) return null
  const name = normalizeName(typeof spec === 'string' ? spec : spec.name)
  if (!name) return null
  const aliases = Array.isArray(spec?.aliases) ? spec.aliases.map(normalizeName).filter(Boolean) : []
  const subtopic = spec?.subtopic ? normalizeName(spec.subtopic) : ''
  return { name, aliases: aliases.slice(0, 8), subtopic }
}

export function ensurePinned(db, upsertTopic) {
  return upsertTopic(db, PINNED_TOPIC.name, { pinned: true, aliases: PINNED_TOPIC.aliases })
}

export { findTopic }
