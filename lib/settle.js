// dsh-diary / lib/settle.js
// 从一段对话里结算出「事件」：规则筛一遍，能提炼主题的挂主题，提炼不了的不写。

import { insertEntry, insertDetail, upsertTopic, linkEntryTopic, dayKeyOf, dayStats, search, topicsOfEntry } from './db.js'
import { matchTopics, cleanTopicSpec } from './topics.js'

const GREETINGS = /^(在吗|在么|你好|您好|哈喽|hi|hello|早安|早上好|午安|晚安|睡了|拜拜|再见|嗯+|哦+|好+|行|ok|收到|谢谢|多谢|没事|随便)[\s!！。.~～]*$/i

const TEMPLATE_JUNK = /^(嗯|哦|好|行|可以|对|是的|不是|哈哈+|嘿嘿+|草|6|1)$/

/** 命令式的「接着来」：够长也不值得单独记一条。 */
const CONTINUE = /^(继续|接着|然后呢|往下|继续吧|接着说|go on|next)[\s!！。.~～]*$/i

export function sanitize(text, max = 120) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, '〔代码〕')
    .replace(/`[^`]{0,80}`/g, '〔代码〕')
    .replace(/https?:\/\/\S+/g, '〔链接〕')
    .replace(/[A-Za-z]:\\[^\s，。；、）)】\]]+/g, '〔路径〕')
    .replace(/~\/(?:[^\s，。；、）)】\]]+)/g, '〔路径〕')
    .replace(/\b\d{7,}\b/g, '〔数字〕')
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '〔串〕')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

export function isSubstantive(text) {
  const s = sanitize(text, 200)
  if (!s || s.length < 4) return false
  if (GREETINGS.test(s)) return false
  if (TEMPLATE_JUNK.test(s)) return false
  return true
}

/** 她的想法：优先用她那句回复里最像「看法」的一句，取不到就明说没感觉。 */
export function takeOf(replyText) {
  const s = sanitize(replyText, 200)
  if (!s) return '没什么特别的感觉。'
  const parts = s.split(/[。！？!?~\n]/).map((x) => x.trim()).filter(Boolean)
  const pick = parts.find((p) => p.length >= 6) || parts[0] || s
  return pick.slice(0, 60)
}

export function makeEntry({ userText, replyText, ch, at, session, vis }) {
  const gist = sanitize(userText, 40)
  return {
    at,
    day: dayKeyOf(at),
    ch,
    kind: guessKind(userText),
    gist,
    take: takeOf(replyText),
    imp: guessImp(userText, replyText),
    vis,
    session,
    source: 'settle',
  }
}

function guessKind(text) {
  const s = String(text)
  if (/答应|说好|约好|一定|回头|明天给你|记得/.test(s)) return 'promise'
  if (/难过|开心|烦|累|生气|委屈|想你|喜欢/.test(s)) return 'mood'
  if (/报错|bug|代码|插件|配置|安装|部署|测试|日志/.test(s)) return 'work'
  return 'chat'
}

function guessImp(userText, replyText) {
  const s = String(userText || '')
  let imp = 0.2
  if (/答应|说好|约好|一定|承诺/.test(s)) imp = 0.9
  else if (/转账|付款|钱|额度|密码|token/.test(s)) imp = 0.7
  else if (/报错|bug|插件|部署|安装|配置/.test(s)) imp = 0.45
  if (String(replyText || '').length > 60) imp += 0.05
  return Math.min(1, imp)
}

/**
 * 该不该把这一句写进账本。
 * 记的标准是「有分量」：能挂上主题、或重要度够高、或本身说得够长。
 * 闲聊流水（「继续」「然后呢」「你看一下」）不进账——那部分交给会话原文和上下文摘要。
 */
export function worthKeeping({ text, imp, kind = 'chat', topics = [] }, { minImp = 0.4, minLen = 16 } = {}) {
  const len = sanitize(text, 200).length
  if (kind === 'promise') return true
  if (topics.length) return true
  if (imp >= minImp) return true
  if (len >= minLen && !CONTINUE.test(sanitize(text, 40))) return true
  return false
}

/**
 * 把一段对话结算成若干条记录。
 * msgs: [{ role: 'user'|'assistant', text, at }]
 * stats: 可选，出参；会写上 { candidates, written, skipped }
 * 返回写进去的条目数组。
 */
export function settle({ db, msgs, ch, session, vis = 'private', now = Date.now(), extractor = null, minImp = 0.4, minLen = 16, stats = null }) {
  const out = []
  let lastUser = null
  let lastReply = ''
  for (const m of msgs) {
    if (m.role === 'user') {
      if (lastUser && isSubstantive(lastUser.text)) out.push({ userText: lastUser.text, replyText: lastReply, at: lastUser.at })
      lastUser = m
      lastReply = ''
    } else if (m.role === 'assistant') {
      lastReply = m.text || lastReply
    }
  }
  if (lastUser && isSubstantive(lastUser.text)) out.push({ userText: lastUser.text, replyText: lastReply, at: lastUser.at })

  const written = []
  let skipped = 0
  for (const item of out) {
    const base = makeEntry({ ...item, ch, session, vis })
    // 先看她这句话里有没有已经存在的主题
    const hits = matchTopics(db, item.userText, 3)
    let topics = hits.map((h) => h.topic)

    // 规则认不出来时，才请 extractor（一次小模型）帮忙；没有就留空，不硬造主题
    let extraSpec = null
    if (!topics.length && extractor) {
      try { extraSpec = cleanTopicSpec(extractor(item.userText)) } catch { extraSpec = null }
    }
    if (extraSpec) {
      const t = upsertTopic(db, extraSpec.name, { aliases: extraSpec.aliases })
      if (t) topics = [t]
    }

    if (!worthKeeping({ text: item.userText, imp: base.imp, kind: base.kind, topics }, { minImp, minLen })) {
      skipped += 1
      continue
    }

    const row = insertEntry(db, { ...base, imp: base.imp })
    for (const t of topics) linkEntryTopic(db, row.id, t.id, 1)
    written.push({ ...row, topics: topicsOfEntry(db, row.id) })
  }
  if (stats) {
    stats.candidates = out.length
    stats.written = written.length
    stats.skipped = skipped
  }
  return written
}

export function journalTextFor(db, day, { vis = null } = {}) {
  const st = dayStats(db, day, { vis })
  if (!st.total) return ''
  const items = search(db, { from: Date.parse(`${day}T00:00:00`), to: Date.parse(`${day}T23:59:59`), limit: 40, vis })
  const lines = items.map((e) => {
    const t = e.topics?.[0]?.name
    return `- ${t ? `[${t}] ` : ''}${e.gist}${e.take ? ` —— 我当时想：${e.take}` : ''}`
  })
  return [`# ${day}`, '', `今天记下 ${st.total} 件事。`, '', ...lines].join('\n')
}

/** 详情：给「以后想看详细内容」用，存标题、正文、来源元信息。 */
export function addDetail(db, { entryId, kind = 'note', title = '', body = '', meta = {}, at = Date.now() }) {
  return insertDetail(db, { entryId, kind, title, body: String(body || ''), meta, at })
}
