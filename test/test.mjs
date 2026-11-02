// dsh-diary 自检：不碰真实 ~/.dsh，全部在临时目录里跑。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { bigram, openDb, insertEntry, insertDetail, search, findTopic, upsertTopic, linkEntryTopic, mergeTopics, entriesOfTopic, dayKeyOf, dayStats, entriesMissingVec, vecStats } from '../lib/db.js'
import { importanceOf, preferenceSlots, matchTopics, PINNED_TOPIC, ensurePinned, freshOf } from '../lib/topics.js'
import { settle, isSubstantive, sanitize, takeOf } from '../lib/settle.js'
import { expandWithDictionary, cosine, normalizeVec } from '../lib/semantic.js'
import { apply, visFor, dayKeysBack, dueSettleDays } from '../lib/index.js'
import { ingestBili, parseWatched, topicFromTitle } from '../lib/bili.js'
import { ingestPet, parsePetMemory } from '../lib/pet.js'

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

/* 5.5 补向量：老记录没向量能查出来，补上之后缺口变小 */
t('missing-vec', () => {
  const db = openDb(dir)
  const before = vecStats(db)
  assert.ok(before.total >= 1, `库里该有记录，实际 ${before.total}`)
  assert.equal(before.done, 0, '测试库还没建过向量')
  assert.equal(before.missing, before.total)
  const rows = entriesMissingVec(db, 50)
  assert.equal(rows.length, before.total, '没建向量的都该被取出来')
  assert.ok(rows[0].id && rows[0].gist, '要带 id 和摘要')
  assert.equal(entriesMissingVec(db, 1).length, 1, 'limit 要生效')
  const { putVec } = { putVec: (d, id, v) => d.prepare('INSERT INTO vec(entry_id, dim, data, model, at) VALUES(?, ?, ?, ?, ?)').run(id, 3, Buffer.from(new Float32Array(v).buffer), 't', Date.now()) }
  putVec(db, rows[0].id, [1, 0, 0])
  const after = vecStats(db)
  assert.equal(after.done, 1)
  assert.equal(after.missing, before.total - 1)
  assert.ok(!entriesMissingVec(db, 50).some((r) => r.id === rows[0].id), '补过的不该再出现')
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

/* 10.5 记账门槛：短流水不进账，够长/够重/有主题才记 */
t('settle-gate', () => {
  const db = openDb(dir)
  const now = Date.now()
  const stats = {}
  const msgs = [
    { role: 'user', text: '继续吧', at: now },
    { role: 'user', text: '你看一下那个', at: now },
    { role: 'user', text: '帮我跑个测试', at: now },
    { role: 'user', text: '我把 favicon 换成新的了，顺手挪了下启动脚本的位置', at: now },
    { role: 'assistant', text: '换好了，启动脚本那个我再确认一遍。', at: now },
  ]
  const written = settle({ db, msgs, ch: 'desktop', session: 's2', vis: 'private', stats })
  assert.equal(written.length, 1, '只有够长那句进账')
  assert.ok(/favicon|启动脚本/.test(written[0].gist), written[0].gist)
  assert.equal(stats.candidates, 3, '三条实质短句 + 一条长句里的实质句')
  assert.equal(stats.skipped, 2, '两条短流水被跳过')
  // 门槛可调：调低就全收
  const loose = settle({ db, msgs, ch: 'desktop', session: 's3', vis: 'private', minImp: 0, minLen: 1 })
  assert.equal(loose.length, 3, 'minImp/minLen 调低后短句也记')
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

  // 可见性判定：只有主人私聊算私事；没配 owner 时 QQ 一律公开
  assert.equal(visFor('desktop-abc', '', ''), 'private')
  assert.equal(visFor('onebot-private-10001', '10001'), 'private')
  assert.equal(visFor('onebot-private-10002', '10001'), 'public')
  assert.equal(visFor('onebot-private-10001', ''), 'public', '没配 owner 不能默认当私事')
  assert.equal(visFor('onebot-group-10001', '10001'), 'public', '群聊一律公开')
  assert.equal(visFor('bili-whale', '10001'), 'public')
  assert.equal(visFor('onebot-private-10001', '10001', 'qq'), 'private')
})

/* 12. 语义层的兜底：词典扩词 + 余弦 */
t('semantic-fallback', () => {
  const extra = expandWithDictionary('那首主题曲叫什么')
  assert.ok(extra.includes('bgm') || extra.includes('配乐'), String(extra))
  const v1 = normalizeVec([1, 0, 0])
  const v2 = normalizeVec([1, 1, 0])
  assert.ok(Math.abs(cosine(v1, v2) - 0.7071) < 0.01)
})

/* 13. 补跑：漏掉的日子要算得出来，太老的不追 */
t('catchup', () => {
  assert.deepEqual(dayKeysBack(2, '2026-11-02'), ['2026-10-31', '2026-11-01', '2026-11-02'])
  // 23:50 前今天不算欠，昨天算
  assert.deepEqual(dueSettleDays('2026-10-31', '2026-11-02', 3, '10:00', '23:50'), ['2026-11-01'])
  // 过了 23:50 今天也算
  assert.deepEqual(dueSettleDays('2026-10-31', '2026-11-02', 3, '23:59', '23:50'), ['2026-11-01', '2026-11-02'])
  // 昨天刚结过 → 今天 23:50 前不欠
  assert.deepEqual(dueSettleDays('2026-11-01', '2026-11-02', 3, '10:00', '23:50'), [])
  // 只补最近 catchupDays 天，更老的翻篇，不天天重试
  assert.deepEqual(dueSettleDays('2026-10-25', '2026-11-02', 3, '10:00', '23:50'), ['2026-10-30', '2026-10-31', '2026-11-01'])
})

/* 13.5 B站：从「看过」表收视频，一个视频一条记录 + 一个主题，按 BV 去重 */
t('bili', () => {
  const md = [
    '# 阿尔法·B站 日记',
    '',
    '## 看过',
    '',
    '| 时间 | BV | 标题 | 想法 |',
    '| --- | --- | --- | --- |',
    '| 2026-11-02 02:40 | BV1RGNJzCEXq | 《原神》纳塔前瞻音乐会 | 交响乐那一段起鸡皮疙瘩 |',
    '| 2026-11-02 03:10 | BV1DubxzVEPB | 【猫meme】我家猫又被镜子吓到 |  |',
    '| — | 不是BV | 坏行 | 应该被跳过 |',
    '| 2026-11-02 03:20 | BV1DubxzVEPB | 【猫meme】我家猫又被镜子吓到 | 重复一行 |',
  ].join('\n')
  const rows = parseWatched(md)
  assert.equal(rows.length, 3, '坏行跳过，重复行先都抠出来（去重交给 ingest）')
  assert.equal(rows[0].bv, 'BV1RGNJzCEXq')
  assert.equal(rows[0].title, '《原神》纳塔前瞻音乐会')
  assert.equal(rows[0].thought, '交响乐那一段起鸡皮疙瘩')
  assert.ok(rows[0].atMs > 0, '时间要能解析出来')
  assert.equal(topicFromTitle('《原神》纳塔前瞻音乐会'), '原神')
  assert.equal(topicFromTitle('【猫meme】我家猫又被镜子吓到'), '猫meme')
  assert.equal(topicFromTitle(''), '')

  const db = openDb(dir)
  const file = join(dir, 'whale-diary.md')
  writeFileSync(file, md, 'utf8')
  const first = ingestBili({ db, file })
  assert.equal(first.added, 2, '第一次跑该收两条')
  assert.equal(ingestBili({ db, file }).added, 0, '按 BV 去重，重复跑不再入账')

  const e = db.prepare("SELECT * FROM entries WHERE ref = 'bili:BV1RGNJzCEXq'").get()
  assert.ok(e, '要按 ref=bili:<BV> 落一条记录')
  assert.equal(e.ch, 'bili')
  assert.equal(e.vis, 'public', 'B站 的记录是公开的')
  assert.equal(e.kind, 'watch')
  assert.equal(e.source, 'bili')
  assert.ok(e.take.includes('起鸡皮疙瘩'), e.take)

  const quiet = db.prepare("SELECT * FROM entries WHERE ref = 'bili:BV1DubxzVEPB'").get()
  assert.ok(quiet.take.length > 0, '没写想法也不能让「她的想法」空着')

  const topics = db.prepare('SELECT t.name FROM topics t JOIN entry_topics et ON et.topic_id = t.id WHERE et.entry_id = ?').all(e.id).map((r) => r.name)
  assert.ok(topics.includes('原神'), `标题里的作品要成为主题：${topics}`)

  const det = db.prepare('SELECT * FROM details WHERE entry_id = ?').get(e.id)
  assert.ok(det && det.body.includes('BV1RGNJzCEXq'), '详情层要存 BV')
  db.close()
})

/* 13.6 桌面：桌宠的聊天入账，一问一答一条，按 ref 去重 */
t('pet', () => {
  const mem = JSON.stringify({
    main: {
      main: {
        messages: [
          { role: 'user', content: '今天好累啊，不想动', ts: 1793604700000 },
          { role: 'assistant', content: '那就趴一会儿，我陪你。', ts: 1793604701000 },
          { role: 'user', content: '嗯', ts: 1793604702000 },
          { role: 'user', content: '晚上想吃什么好呢', ts: 1793604720000 },
          { role: 'assistant', content: '想吃热的，汤面吧。', ts: 1793604721000 },
        ],
      },
    },
  })
  const pairs = parsePetMemory(mem)
  assert.equal(pairs.length, 3, '一问一答配对，「嗯」也算一问（只是不记账）')
  assert.equal(pairs[0].reply, '那就趴一会儿，我陪你。')
  assert.ok(pairs[0].ref.startsWith('pet:main/main/'), pairs[0].ref)
  assert.deepEqual(parsePetMemory('不是 json'), [], '读坏不炸')

  const h = mkdtempSync(join(tmpdir(), 'dsh-diary-pet-'))
  const db = openDb(h)
  const file = join(h, 'memory.json')
  writeFileSync(file, mem, 'utf8')
  assert.equal(ingestPet({ db, file }).added, 2, '像样的两问答该记两条，寒暄跳过')
  assert.equal(ingestPet({ db, file }).added, 0, '按 ref 去重，重复轮询不写两遍')

  const e = db.prepare("SELECT * FROM entries WHERE source = 'pet' ORDER BY at LIMIT 1").get()
  assert.equal(e.ch, 'desktop')
  assert.equal(e.vis, 'private', '桌宠聊天是私事')
  assert.equal(e.kind, 'mood', '「累」算情绪')
  assert.ok(e.take.includes('趴一会儿'), e.take)
  const det = db.prepare('SELECT * FROM details WHERE entry_id = ?').get(e.id)
  assert.ok(det && det.body.includes('今天好累啊'), '详情要留原话')
  db.close()
  rmSync(h, { recursive: true, force: true })
})

/* 14. 宿主接线：假 ctx 跑一遍 apply，四个以上工具必须注册上 */
await ta('plugin-wiring', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-diary-home-'))
  // 上次没结算完的消息（比如 23:50 那会儿电脑已经关了）：重启后必须补回来
  const yesterdayAt = Date.now() - 86_400_000
  const yday = dayKeyOf(yesterdayAt)
  writeFileSync(join(home, 'pending.jsonl'), [
    JSON.stringify({ sid: 'onebot-private-10001', ch: 'qq', vis: 'private', role: 'user', text: '昨天的复盘：我打算把账本导出一份 markdown 看看结构', at: yesterdayAt }),
    JSON.stringify({ sid: 'onebot-private-10001', ch: 'qq', vis: 'private', role: 'assistant', text: '那就先导一份试试，结构乱不乱我帮你看。', at: yesterdayAt + 1000 }),
  ].join('\n') + '\n', 'utf8')
  // B站 的「看过」表：启动时就该收进账本
  writeFileSync(join(home, 'whale-diary.md'), [
    '# 阿尔法·B站 日记',
    '## 看过',
    '| 时间 | BV | 标题 | 想法 |',
    '| --- | --- | --- | --- |',
    `| ${new Date().toISOString().slice(0, 10)} 02:40 | BV1RGNJzCEXq | 《原神》纳塔前瞻音乐会 | 交响乐那段起鸡皮疙瘩 |`,
  ].join('\n') + '\n', 'utf8')
  // 桌宠的聊天：它不走 DSH 会话，只落在 dsh-pet 的 memory.json 里
  writeFileSync(join(home, 'memory.json'), JSON.stringify({
    main: { main: { messages: [
      { role: 'user', content: '今天好累啊，不想动', ts: Date.now() },
      { role: 'assistant', content: '那就趴一会儿，我陪你。', ts: Date.now() },
    ] } },
  }), 'utf8')
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
  const dispose = apply(ctx, {
    dir: home,
    semantic: false,
    ownerQQ: '10001',
    biliWatchPath: join(home, 'whale-diary.md'),
    petMemoryPath: join(home, 'memory.json'),
    desktopFromSessions: true, // 这个用例要验证桌面会话侧的旧行为；默认是关的，见文件末尾
  })

  try {
    // 启动补跑：昨天没结算的 QQ 消息恢复后要进库，日记也要补出来
    const db2 = openDb(home)
    const yentry = db2.prepare('SELECT * FROM entries WHERE day = ? AND ch = ?').get(yday, 'qq')
    assert.ok(yentry, '昨天没结算的 QQ 消息该在启动时补上')
    const yjournal = db2.prepare('SELECT * FROM journal WHERE day = ?').get(yday)
    assert.ok(yjournal && yjournal.text.includes(yentry.gist), '昨天的日记该补出来')
    assert.equal(db2.prepare("SELECT value FROM meta WHERE key = 'qq_settled_day'").get().value, yday)
    // 启动时的 B站 入账
    const bentry = db2.prepare("SELECT * FROM entries WHERE ref = 'bili:BV1RGNJzCEXq'").get()
    assert.ok(bentry, '启动时该把 B站 看过表收进账本')
    assert.equal(bentry.ch, 'bili')
    assert.equal(bentry.vis, 'public')
    // 启动时的桌宠入账
    const pentry = db2.prepare("SELECT * FROM entries WHERE source = 'pet'").get()
    assert.ok(pentry, '启动时该把桌宠的聊天收进账本')
    assert.equal(pentry.ch, 'desktop')
    assert.equal(pentry.vis, 'private')
    db2.close()
    assert.equal(readFileSync(join(home, 'pending.jsonl'), 'utf8'), '', '结算过的消息要从 pending 里清掉')

    assert.ok(tools.size >= 8, `工具太少：${[...tools.keys()]}`)
    assert.ok(tools.has('diary_reindex'), '要有补向量的工具')
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
    const r1 = await rec.execute({ gist: '她说想听原神的原声带', take: '我也想听', topic: '原神原声', detail: '她原话：「那首原声带帮我留着」。' }, { agent })
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
    assert.ok(pub.includes('纳塔') || pub.includes('音乐会'), `B站 该看得见自己看过的视频：${pub}`)

    // 主人私聊 = 私事；陌生人的 QQ 私聊 = 公开视角
    const ownerSid = 'onebot-private-10001'
    const ownerAgent = { session: { id: ownerSid, header: { id: ownerSid, cwd: 'C:\\x\\alpha', title: '主人' } } }
    fire('session/created', ownerAgent.session)
    fire('agent/inbox/claimed', {
      agent: ownerAgent,
      message: { id: 'm2', content: [{ type: 'text', text: '今天加班到很晚，回家路上月亮特别大' }], source: { kind: 'user' } },
    })
    fire('session/event', ownerAgent.session, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '那你早点睡，月亮我替你看了。' }] } },
    })
    fire('session/disposed', ownerAgent.session)

    const own = await searchTool.execute({ query: '月亮' }, ownerAgent)
    assert.ok(own.includes('月亮'), `主人该看得见自己的私聊：${own}`)
    const stranger = { agent: { session: { id: 'onebot-private-99999', header: { id: 'onebot-private-99999' } } } }
    const str = await searchTool.execute({ query: '月亮' }, stranger)
    assert.ok(!str.includes('月亮'), `陌生人的 QQ 私聊不该看见私事：${str}`)

    // 详情 / 主题榜 / 日记：公开视角都不漏私事
    const raw = openDb(home)
    const pr = raw.prepare("SELECT * FROM entries WHERE vis = 'private' AND ref IS NOT NULL ORDER BY at DESC LIMIT 1").get()
    assert.ok(pr, '该有一条带详情的私事')
    raw.prepare('INSERT INTO journal(day, text, at, model) VALUES(?, ?, ?, ?) ON CONFLICT(day) DO UPDATE SET text = excluded.text')
      .run(dayKeyOf(Date.now()), '# 私人日记\n- 月亮很大', Date.now(), 'rule')
    raw.close()

    const det = tools.get('diary_detail')
    assert.ok((await det.execute({ id: pr.id }, bili)).includes('私事'), 'B站 不能按 id 翻私事的详情')
    assert.ok((await det.execute({ id: '原声带' }, bili)).includes('找不到'), 'B站 不能按片段翻私事的详情')
    assert.ok((await det.execute({ id: pr.id }, agent)).includes('原声带'), '主人自己能看到详情')

    const tpub = await list.execute({}, bili)
    assert.ok(!tpub.includes('原神原声'), `B站 不该看见只在私事里出现的主题：${tpub}`)
    assert.ok(tl.includes('原神原声'), '桌面视角看得到这个主题')

    // 日记：存下来的是私人版，公开视角要现算 public 版
    const jt = tools.get('diary_journal')
    const j = await jt.execute({}, { agent })
    assert.ok(j.includes('私人日记'), j)
    const jpub = await jt.execute({}, bili)
    assert.ok(!jpub.includes('私人日记'), `B站 不该拿到存下来的私人日记：${jpub}`)
    assert.ok(!jpub.includes('月亮'), `B站 的日记不该含私事：${jpub}`)

    // 落盘物证
    assert.ok(existsSync(join(home, 'diary.db')), 'diary.db 应该存在')
    assert.ok(existsSync(join(home, 'register-ok.json')), 'register-ok.json 应该存在')
    const jsonls = readdirSync(home).filter((f) => f.endsWith('.jsonl'))
    assert.ok(jsonls.length >= 1, 'JSONL 原始流水应该也在写')

    // 默认：桌面通道只记桌宠，写代码的桌面会话不进账本
    const home2 = mkdtempSync(join(tmpdir(), 'dsh-diary-home2-'))
    const h2 = new Map()
    const t2 = new Map()
    const ctx2 = {
      logger: { info() {}, warn() {}, error() {} },
      on(ev, fn) { h2.set(ev, [...(h2.get(ev) || []), fn]); return () => {} },
      effect(fn) { const d = fn(); return () => { try { d?.() } catch {} } },
      get() { return undefined },
      tools: { register(tool) { t2.set(tool.name, tool) } },
      systemPrompt: { section(def) { return () => {} } },
    }
    const fire2 = (ev, ...args) => { for (const fn of h2.get(ev) || []) fn(...args) }
    const dispose2 = apply(ctx2, { dir: home2, semantic: false, petWatch: false })
    try {
      const a2 = { session: { id: 'desktop-s9', header: { id: 'desktop-s9', cwd: 'C:\\x\\alpha', title: '施工' } } }
      fire2('session/created', a2.session)
      fire2('agent/inbox/claimed', { agent: a2, message: { id: 'x1', content: [{ type: 'text', text: '帮我看看这个插件的日志该怎么写' }], source: { kind: 'user' } } })
      fire2('session/event', a2.session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '先打到标准输出就行。' }] } } })
      fire2('session/disposed', a2.session)
      const d3 = openDb(home2)
      assert.equal(d3.prepare("SELECT count(*) AS n FROM entries WHERE ch = 'desktop'").get().n, 0, '桌面会话不该进账本')
      d3.close()
    } finally {
      try { dispose2?.() } catch {}
      try { rmSync(home2, { recursive: true, force: true }) } catch {}
    }
  } finally {
    try { dispose?.() } catch {}
    try { rmSync(home, { recursive: true, force: true }) } catch {}
  }
})

console.log(`diary ok（${ok.length} 组）`)
for (const n of ok) console.log('  ✓', n)
