// dsh-diary / lib/memo.js
// 「她自己的想法」：结算时一次批量问小模型；问不到就用规则截句。
//
// 只在结算时调（QQ 日结/补跑一次、桌宠轮询一次），不跟每轮对话；
// 没模型、超时、输出不是 JSON 数组，全部退回 takeOf，绝不让建模挡住入账。
//
// 不 import @deepseek-ai/dsh-llm：插件所在的模块图里不一定有它。
// 自己拼 messages，流里只认 text-delta（和 dsh-feiyu-mood 的做法一样）。
//
// 取模型靠 ctx.agentDefaultModel / ctx.llm.stream 两个服务，
// 都必须在 inject 里声明，否则 ctx 上根本看不到（0.1.9 踩过这个坑）。

import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { sanitize } from './settle.js'

// 诊断落盘：宿主里没有可读日志，出问题只能看这个文件。写入失败就算了，绝不抛。
const LOG_PATH = join(homedir(), '.dsh', 'diary', 'think.log')
function diag(obj) {
  try {
    appendFileSync(LOG_PATH, `${JSON.stringify({ at: new Date().toISOString(), ...obj })}\n`)
  } catch { /* 诊断失败不影响主流程 */ }
}

export const MEMO_SYSTEM = [
  '你在替一个人整理她自己在聊天里「当时的想法」，准备写进她的日记。',
  '输入是若干段对话，每段有「他说」和「我说」。',
  '请给每一段写一句她当时的想法，规则：',
  '1. 第一人称、口语，像随手写在日记里的一句；',
  '2. 每条 8–40 字，写「我在意什么 / 我觉得什么 / 我打算什么」，不要复述对话；',
  '3. 不编造没发生的事，不写「作为 AI」，不用表情符号；',
  '4. 只输出 JSON 字符串数组，条数和段数相同，例如 ["……","……"]。',
].join('\n')

/** 从模型输出里抠出 take 数组；抠不出来返回 null。 */
export function parseTakes(text, n) {
  const count = Math.max(0, Number(n) || 0)
  const s = String(text || '')
    .replace(/^\s*```[a-zA-Z]*\s*/, '')
    .replace(/```\s*$/, '')
  const a = s.indexOf('[')
  const b = s.lastIndexOf(']')
  if (a < 0 || b <= a) return null
  let arr = null
  try { arr = JSON.parse(s.slice(a, b + 1)) } catch { return null }
  if (!Array.isArray(arr) || !arr.length) return null
  const out = arr.slice(0, count).map((x) => {
    const raw = typeof x === 'string' ? x : (x && (x.take || x.thought || x.text)) || ''
    return sanitize(raw, 60)
  })
  while (out.length < count) out.push('')
  return out.some(Boolean) ? out : null
}

function clip(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/**
 * 小模型写「想法」。
 * 用法：const thinker = createThinker(ctx, { logger })
 *       const takes = await thinker.ask([{ userText, replyText }, …])
 * 返回字符串数组（与传入等长，可能含空串）；不可用/失败返回 null。
 */
export function createThinker(ctx, { logger = null, timeoutMs = 30_000, batch = 12, sessionId = 'dsh-diary', log = true } = {}) {
  const note = log ? diag : () => {}
  function selection() {
    try {
      const sel = ctx?.agentDefaultModel?.currentSelection?.()
      if (sel?.provider && sel?.model) return { provider: sel.provider, model: sel.model }
      const alt = ctx?.agentDefaultModel?.default?.()
      if (alt?.provider && alt?.model) return { provider: alt.provider, model: alt.model }
    } catch { /* 下面统一返回 null */ }
    return null
  }
  let warnedUnusable = false
  function usable() {
    const hasStream = typeof ctx?.llm?.stream === 'function'
    const sel = selection()
    if ((!sel || !hasStream) && !warnedUnusable) {
      warnedUnusable = true
      let keys = []
      try { keys = Object.keys(ctx || {}).slice(0, 40) } catch { /* cordis ctx 可能不让枚举 */ }
      note({ phase: 'unusable', hasSelection: !!sel, hasStream, ctxKeys: keys })
    }
    return Boolean(sel) && hasStream
  }

  async function askBatch(sel, items) {
    const body = items
      .map((it, i) => `【${i + 1}】他说：${clip(it.userText, 240)}\n我说：${clip(it.replyText, 240) || '（没回）'}`)
      .join('\n\n')
    note({ phase: 'start', items: items.length, provider: sel.provider, model: sel.model, chars: body.length })
    let out = ''
    try {
      for await (const chunk of ctx.llm.stream({
        provider: sel.provider,
        model: sel.model,
        sessionId,
        system: MEMO_SYSTEM,
        messages: [{
          role: 'user',
          id: globalThis.crypto?.randomUUID?.() || `memo-${Date.now()}`,
          content: [{ type: 'text', text: body }],
          source: { kind: 'plugin', plugin: 'dsh-diary' },
        }],
        temperature: 0.5,
        maxTokens: Math.max(400, items.length * 90),
        signal: AbortSignal.timeout(timeoutMs),
      })) {
        if (!chunk) continue
        if (chunk.type === 'text-delta') out += chunk.text || ''
        else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
          throw new Error(chunk.reason?.failure?.message || '模型返回错误')
        }
      }
    } catch (err) {
      note({ phase: 'error', msg: String(err?.message || err) })
      logger?.warn?.(`[diary] 想法生成失败，退回规则：${err?.message || err}`)
      return null
    }
    const takes = parseTakes(out, items.length)
    note({ phase: takes ? 'ok' : 'parse-fail', outLen: out.length, preview: out.slice(0, 300) })
    if (!takes) logger?.warn?.('[diary] 想法的不是 JSON 数组，退回规则')
    return takes
  }

  return {
    usable,
    async ask(items) {
      if (!Array.isArray(items) || !items.length) return null
      const sel = selection()
      if (!sel || typeof ctx?.llm?.stream !== 'function') {
        note({
          phase: 'no-selection',
          hasModelService: typeof ctx?.agentDefaultModel,
          modelKeys: Object.keys(ctx?.agentDefaultModel || {}).slice(0, 12),
          ctxKeys: Object.keys(ctx || {}).slice(0, 40),
          hasStream: typeof ctx?.llm?.stream,
        })
        return null
      }
      const all = []
      for (let i = 0; i < items.length; i += batch) {
        const part = await askBatch(sel, items.slice(i, i + batch))
        if (!part) return null
        all.push(...part)
      }
      return all
    },
  }
}
