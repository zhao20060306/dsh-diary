// dsh-diary / lib/semantic.js
// 语义层：向量优先（本地 bge-small-zh），改写兜底（同义扩词，可选一次小模型调用）。
// 两者都不可用时退回纯关键词，绝不抛错、绝不让插件起不来。

import { allVecs, putVec } from './db.js'

const DEFAULT_MODEL = 'Xenova/bge-small-zh-v1.5'

/** 常见中文同义改写：查询里出现左边的词，就补上右边的词一起检索。 */
const SYNONYMS = [
  ['主题曲', 'op', 'ed', 'bgm', '配乐', 'ost', '片头曲', '片尾曲', '插曲'],
  ['bgm', '主题曲', '配乐', 'ost', '音乐'],
  ['配乐', '主题曲', 'bgm', 'ost'],
  ['番', '动画', '动漫', '番剧'],
  ['动画', '番', '动漫', '番剧'],
  ['游戏', '手游', '端游'],
  ['视频', 'b站', '哔哩哔哩'],
  ['模型', '大模型', 'llm'],
  ['插件', '扩展', 'plugin'],
  ['人格', '人设', '角色'],
]

export function expandWithDictionary(text) {
  const s = String(text || '').toLowerCase()
  const extra = new Set()
  for (const group of SYNONYMS) {
    const head = group[0]
    if (s.includes(head.toLowerCase())) {
      for (const w of group) if (w !== head) extra.add(w)
    }
  }
  return Array.from(extra).slice(0, 8)
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  if (!na || !nb) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export function normalizeVec(v) {
  let n = 0
  for (const x of v) n += x * x
  n = Math.sqrt(n) || 1
  return Array.from(v, (x) => x / n)
}

/**
 * 懒加载本地 embedder。装不上/下不动就返回 null，插件照常用关键词。
 * 模型默认 24 MB（q8），国内走 hf-mirror。
 */
export function createEmbedder({ model = DEFAULT_MODEL, hfEndpoint = '', logger = null } = {}) {
  let pipe = null
  let loading = null
  let failed = null

  async function init() {
    if (pipe) return pipe
    if (failed) return null
    if (loading) return loading
    loading = (async () => {
      try {
        const mod = await import('@huggingface/transformers')
        if (hfEndpoint) {
          try { mod.env.remoteHost = hfEndpoint } catch {}
        }
        try { mod.env.allowLocalModels = false } catch {}
        const ext = await mod.pipeline('feature-extraction', model, { dtype: 'q8' })
        pipe = ext
        logger?.info?.(`[diary] 向量模型就绪：${model}`)
        return pipe
      } catch (err) {
        failed = err
        logger?.warn?.(`[diary] 向量模型不可用，退回关键词：${err?.message || err}`)
        return null
      }
    })()
    return loading
  }

  return {
    model,
    get available() { return !!pipe },
    get unavailableReason() { return failed ? String(failed?.message || failed) : null },
    async embed(text) {
      const p = await init()
      if (!p) return null
      try {
        const out = await p(String(text || '').slice(0, 1000), { pooling: 'mean', normalize: true })
        const arr = out?.data ? Array.from(out.data) : null
        return arr && arr.length ? normalizeVec(arr) : null
      } catch (err) {
        logger?.warn?.(`[diary] 向量化失败：${err?.message || err}`)
        return null
      }
    },
  }
}

export async function indexEntry(embedder, db, entryId, text) {
  if (!embedder) return false
  const v = await embedder.embed(text)
  if (!v) return false
  putVec(db, entryId, v, embedder.model)
  return true
}

export async function vectorSearch(embedder, db, text, { limit = 20 } = {}) {
  if (!embedder) return []
  const q = await embedder.embed(text)
  if (!q) return []
  const rows = allVecs(db)
  const scored = []
  for (const r of rows) {
    if (r.dim !== q.length) continue
    const s = cosine(q, r.vec)
    if (s > 0.2) scored.push({ entryId: r.entryId, score: s })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

/**
 * 改写兜底：先词典，再（如果有 llmText）追加模型给的同义词。
 * llmText 是注入进来的「给一段提示、返回一段文本」的函数，失败就当没有。
 */
export async function expandQuery(text, { llmText = null, timeoutMs = 4000 } = {}) {
  const fromDict = expandWithDictionary(text)
  if (!llmText) return fromDict
  const prompt = `把这句话里可能出现在别的说法中的关键词列出来，只输出一行，用空格分隔，最多 6 个，不要解释。\n句子：${String(text).slice(0, 200)}`
  try {
    const raw = await Promise.race([
      llmText(prompt),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
    ])
    const words = String(raw || '')
      .split(/[\s,，、;；]+/)
      .map((w) => w.trim())
      .filter((w) => w.length >= 2 && w.length <= 12 && !/[。！？]/.test(w))
      .slice(0, 6)
    return Array.from(new Set([...fromDict, ...words]))
  } catch {
    return fromDict
  }
}
