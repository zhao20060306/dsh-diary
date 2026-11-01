// dsh-diary 自检：不碰真实 ~/.dsh，全部在临时目录里跑。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { bigram, openDb, insertEntry, insertDetail, search, findTopic, upsertTopic, linkEntryTopic, mergeTopics, entriesOfTopic, dayKeyOf, dayStats } from '../lib/db.js'
import { importanceOf, preferenceSlots, matchTopics, PINNED_TOPIC, ensurePinned, freshOf } from '../lib/topics.js'
import { settle, isSubstantive, sanitize, takeOf } from '../lib/settle.js'
import { expandWithDictionary, cosine, normalizeVec } from '../lib/semantic.js'
import { apply } from '../lib/index.js'

const ok = []
function t(name, fn) { fn(); ok.push(name) }
async function ta(name, fn) { await fn(); ok.push(name) }

const dir = mkdtempSync(join(tmpdir(), 'dsh-diary-'))
process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })

/* 1. 分词：中文必须切出 2-gram，否则 FTS 永远搜不到 */
t('bigram', () => {
  const s = bigram('原神主题曲很好听')
  assert.ok(s.includes('原神'), s)
  assert.ok(s.includes('主题'), s)
  assert.ok(!s.includes('原神主题曲很好听'))
  assert.equal(bigram('BGM'), 'bgm')
})

/* 2. 脱敏：路径、链接、长数字、长串都不该落盘 */
t('sanitize', () => {
  const out = sanitize('看 C:\\Users\\x\\a.txt 和 https://a.b/c 还有 3221363832 与 abcdefghijklmnopqrstuvwxyz')
  assert.ok(out.includes('〔路径〕'), out)
  assert.ok(out.includes('〔链接〕'), out)
  assert.ok(out.includes('〔数字〕'), out)
  assert.ok(out.includes('〔串〕'), out)
  assert.ok(!out.includes('32213'))
})

/* 3. 什么算「值得记」 */
t('isSubstantive', () => {
  assert.equal(isSubstantive('在吗'), false)
  assert.equal(isSubstantive('嗯'), false)
  assert.equal(isSubstantive('今天把账本插件写完并测试通过了'), true)
})

/* 4. 她自己的想法不能空 */
t('takeOf', () => {
  assert.equal(takeOf(''), '没什么特别的感觉。')
  assert.ok(takeOf('这个视频的配乐我很喜欢，节奏也对').length > 0)
  assert.ok(takeOf('好的').length > 0)
})

/* 5. 落库 + FTS 检索 */
t('insert+search', () => {
  const db = openDb(dir)
  const row = insertEntry(db, { at: Date.now(), ch: 'desktop', kind: 'chat', gist: '她说原神的主题曲很好听', take: '我也觉得', imp: 0.6, vis: 'private' })
  const hit = search(db, { q: '主题曲' })
  assert.ok(hit.some((r) => r.id === row.id), '关键词检索应命中')
  const miss = search(db, { q: '完全不相干的词' })
  assert.equal(miss.length, 0)
  db.close()
})

/* 6. 主题：认出来、挂上去、多对多（一条记录挂两个主题） */
t('topics-dag', () => {
  const db = openDb(dir)
  const a = upsertTopic(db, '原神', { aliases: ['Genshin', '提瓦特'] })
  const b = upsertTopic(db, '主题曲')
  const e = insertEntry(db, { at: Date.now(), ch: 'desktop', kind: 'chat', gist: '聊了原神的主题曲', take: '好听', vis: 'private' })
  linkEntryTopic(db, e.id, a.id, 1)
  linkEntryTopic(db, e.id, b.id, 1)
  assert.equal(entriesOfTopic(db, a.id).length, 1)
  assert.equal(entriesOfTopic(db, b.id).length, 1)
  // 同一条记录被两个主题指向 —— 这就是「多个主题锁定一个指针」
  const both = search(db, { topics: ['原神', '主题曲'] })
  assert.equal(both.length, 1)
  assert.equal(both[0].hits, 2)
  // 别名能认出来
  const hits = matchTopics(db, '提瓦特那个游戏你玩过吗')
  assert.equal(hits[0].topic.name, '原神')
  db.close()
})

/* 7. 主题合并：边和别名一起搬 */
t('merge', () => {
  const db = openDb(dir)
  const keep = upsertTopic(db, '艾尔登法环')
  const drop = upsertTopic(db, '老头环')
  const e = insertEntry(db, { at: Date.now(), ch: 'desktop', kind: 'chat', gist: '老头环打到最后 boss', take: '好难', vis: 'private' })
  linkEntryTopic(db, e.id, drop.id, 1)
  mergeTopics(db, drop.id, keep.id)
  // 合并后旧名不再是独立主题，但作为别名还能找回同一个东西
  const viaAlias = findTopic(db, '老头环')
  assert.ok(viaAlias, '旧名应该还能通过别名找回')
  assert.equal(viaAlias.id, keep.id, '旧名要指向留下的那个主题')
  assert.equal(db.prepare('SELECT count(*) AS n FROM topics').get().n, 3, '原神 / 主题曲 / 艾尔登法环')
  const merged = findTopic(db, '艾尔登法环')
  assert.ok(merged.aliases.includes('老头环'), '原名要变成别名')
  assert.equal(entriesOfTopic(db, merged.id).length, 1)
  db.close()
})

/* 8. 置顶主题永远第一、不参与竞争 */
t('pinned', () => {
  const db = openDb(dir)
  ensurePinned(db, upsertTopic)
  const pinned = findTopic(db, PINNED_TOPIC.name)
  assert.ok(pinned.pinned === 1)
  assert.equal(importanceOf(pinned), 1)
  upsertTopic(db, '热门游戏')
  const bump = findTopic(db, '热门游戏')
  db.prepare('UPDATE topics SET hits = 999, mention = 1, reaction = 1 WHERE id = ?').run(bump.id)
  const slots = preferenceSlots(db, { max: 6 })
  assert.equal(slots[0], PINNED_TOPIC.name, '第一个位置永远是 AI 人格')
  db.close()
})

/* 9. 重要度：新鲜度会衰减，7 天后归零 */
t('importance', () => {
  const now = Date.now()
  assert.ok(freshOf(now, now) > 0.34)
  assert.equal(freshOf(now - 8 * 86400_000, now), 0)
  const base = { pinned: 0, mention: 0, reaction: 0, boost: 0, last_at: 0 }
  assert.ok(Math.abs(importanceOf(base, now) - 0.15) < 1e-9)
  const hot = { ...base, mention: 1, reaction: 1, last_at: now }
  assert.ok(importanceOf(hot, now) > 0.9)
})

/* 10. 结算：一段对话 → 逐条记录，寒暄不写 */
t('settle', () => {
  const db = openDb(dir)
  const msgs = [
    { role: 'user', text: '在吗', at: Date.now() },
    { role: 'assistant', text: '在呀～', at: Date.now() },
    { role: 'user', text: '今天把原神的帧数问题修好了，改了两处渲染顺序', at: Date.now() },
    { role: 'assistant', text: '改两处渲染顺序就好了？我还以为要动资源加载呢。', at: Date.now() },
  ]
  const written = settle({ db, msgs, ch: 'desktop', session: 's1', vis: 'private' })
  assert.equal(written.length, 1, '只有一句值得记')
  assert.ok(written[0].gist.includes('帧数'))
  assert.ok(written[0].take.length > 0, '她自己的想法不能空')
  db.close()
})

/* 11. 可见性：公开视角看不到私事 */
t('visibility', () => {
  const db = openDb(dir)
  insertEntry(db, { at: Date.now(), ch: 'desktop', kind: 'chat', gist: '聊了家里的事', take: '记下了', vis: 'private' })
  insertEntry(db, { at: Date.now(), ch: 'bili', kind: 'watch', gist: '看了个原神二创', take: '挺有意思', vis: 'public' })
  const pub = search(db, { q: '原神', vis: 'public' })
  assert.ok(pub.every((r) => r.vis === 'public'))
  const all = search(db, { q: '原神' })
  assert.ok(all.length >= pub.length)
  const st = dayStats(db, dayKeyOf(Date.now()), { vis: 'public' })
  assert.ok(st.total >= 1)
  db.close()
})

/* 12. 语义层的兜底：词典扩词 + 余弦 */
t('semantic-fallback', () => {
  const extra = expandWithDictionary('那首主题曲叫什么')
  assert.ok(extra.includes('bgm') || extra.includes('配乐'), String(extra))
  const v1 = normalizeVec([1, 0, 0])
  const v2 = normalizeVec([1, 1, 0])
  assert.ok(Math.abs(cosine(v1, v2) - 0.7071) < 0.01)
})

/* 13. 宿主接线：假 ctx 跑一遍 apply，四个以上工具必须注册上 */
await ta('plugin-wiring', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-diary-home-'))
  const handlers = new Map()
  const tools = new Map()
  const sections = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(ev, fn) { handlers.set(ev, [...(handlers.get(ev) || []), fn]); return () => {} },
    effect(fn) { const d = fn(); return () => { try { d?.() } catch {} } },
    get() { return undefined },
    tools: { register(tool) { tools.set(tool.name, tool) } },
    systemPrompt: { section(def) { sections.push(def); return () => {} } },
  }
  const fire = (ev, ...args) => { for (const fn of handlers.get(ev) || []) fn(...args) }
  const dispose = apply(ctx, { dir: home, semantic: false })

  try {
    assert.ok(tools.size >= 6, `工具太少：${[...tools.keys()]}`)
    assert.equal(sections.length, 1, '要挂一个注入面')
    assert.equal(sections[0].name, 'diary:topic')

    const agent = { session: { id: 'desktop-s1', header: { id: 'desktop-s1', cwd: 'C:\\x\\alpha', title: '日常' } } }
    fire('session/created', agent.session)
    fire('agent/inbox/claimed', {
      agent,
      message: { id: 'm1', content: [{ type: 'text', text: '原神的主题曲真的很好听，我循环了一晚上' }], source: { kind: 'user' } },
    })
    fire('session/event', agent.session, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '那首确实好听，尤其是副歌进来的地方。' }] } },
    })
    // 会话结束 → 结算落盘
    fire('session/disposed', agent.session)

    const searchTool = tools.get('diary_search')
    const out = await searchTool.execute({ query: '主题曲' }, { agent })
    assert.ok(out.includes('主题曲'), `检索输出不该为空：${out}`)

    // 手动写一条 + 建档主题
    const rec = tools.get('diary_record')
    const r1 = await rec.execute({ gist: '她说想听原神的原声带', take: '我也想听', topic: '原神原声' }, { agent })
    assert.ok(r1.includes('原神原声'), r1)

    const list = tools.get('diary_topics')
    const tl = await list.execute({}, { agent })
    assert.ok(tl.includes(PINNED_TOPIC.name), tl)
    assert.ok(tl.includes('B站 六个位置'), tl)

    const today = tools.get('diary_day')
    assert.ok((await today.execute({}, { agent })).includes('条'), '今天该有记录')

    // 公开视角（B站 会话）看不到私事
    const bili = { agent: { session: { id: 'bili-whale', header: { id: 'bili-whale', cwd: 'C:\\x\\alpha', title: 'B站' } } } }
    const pub = await searchTool.execute({ query: '原神' }, bili)
    assert.ok(!pub.includes('她说想听原神的原声带'), `B站 不该看见私聊内容：${pub}`)

    // 日记
    const jt = tools.get('diary_journal')
    const j = await jt.execute({}, { agent })
    assert.ok(j.includes('#'), j)

    // 落盘物证
    assert.ok(existsSync(join(home, 'diary.db')), 'diary.db 应该存在')
    assert.ok(existsSync(join(home, 'register-ok.json')), 'register-ok.json 应该存在')
    const jsonls = readdirSync(home).filter((f) => f.endsWith('.jsonl'))
    assert.ok(jsonls.length >= 1, 'JSONL 原始流水应该也在写')
  } finally {
    try { dispose?.() } catch {}
    try { rmSync(home, { recursive: true, force: true }) } catch {}
  }
})

console.log(`diary ok（${ok.length} 组）`)
for (const n of ok) console.log('  ✓', n)
