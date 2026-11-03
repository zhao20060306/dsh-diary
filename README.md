# dsh-diary

给 DSH 里的 agent 一本**会忘不掉、也查得回来**的账：一件事一条记录，主题自己长出来，想翻的时候按主题或关键词就翻得到。

它是 [dsh-bond](https://github.com/zhao20060306/dsh-bond) 里账本那一半的正式版——把「今天发生了什么」从一行流水，做成能按主题走回过去的索引。（bond 里那份简易账本已于 2026-11-02 停用并删除，现在只剩这一个。）

## 安装

```bash
dsh plugin --profile desktop add "dsh-diary@https://github.com/zhao20060306/dsh-diary/tarball/<commit>"
```

把 `<commit>` 换成具体的提交号。不要用 `tarball/main`：pnpm 会把同一个地址缓存住，你改了 main 它也不会重新拉。

装完重启 DSH。首次启动会在 `~/.dsh/diary/` 建库；启动自检写在 `steps.jsonl`，失败原因写在 `fatal.json`。

想让它真的能「同义改写也能搜到」，装可选依赖：

```bash
cd ~/.dsh/profiles/desktop/node_modules/dsh-diary && npm i @huggingface/transformers
```

不装也能用，只是语义那一步退化成词典扩词。国内建议把 `hfEndpoint` 指到 `https://hf-mirror.com`（默认已经是）。

## 它解决什么问题

普通记忆插件记的是「事实」（你喜欢什么、项目什么结构）。账本记的是**经历**：

- 三天前她看了哪个视频、当时怎么想的
- 上周答应过你什么、兑现了没
- 「那首 BGM」叫什么、在哪个话题下聊过

事实回答「你是谁」，账本回答「我们之间发生过什么」。

## 一条记录长什么样

```json
{
  "id": "e_mv…",
  "at": 1793568724692,
  "day": "2026-11-02",
  "ch": "desktop",
  "kind": "chat",
  "gist": "她说原神的帧数问题已经改好了",
  "take": "改两处渲染顺序确实比动资源加载省事。",
  "imp": 0.62,
  "vis": "private",
  "topics": ["原神", "性能优化"]
}
```

- **gist**：一句话，不存原话（路径、链接、长数字、长串都会被打成 `〔路径〕` 这类占位）
- **take**：她自己的想法。**必填**，可以写「没什么特别的感觉」，但不能空
- **topics**：可以挂多个——一条记录被多个主题指向，这就是「用几个主题锁定同一条记录」
- **vis**：`private` / `public`，决定 B站、QQ 群这些公开场合能不能看见

## 三层结构

| 层 | 存什么 | 量级 | 给谁看 |
|---|---|---|---|
| 账本 `entries` | 一件事一行 | 100–200 字 | 检索、注入 |
| 详情 `details` | 视频信息、长文、完整感想 | 2–8 KB | `diary_detail` 翻开 |
| 日记 `journal` | 一天一篇汇总 | 800–1500 字 | `diary_journal` |

底层是 SQLite（`node:sqlite` 内置，零依赖）+ 每天一份 JSONL 原始流水（可读、可备份、可重建）。

## 什么时候记

- **桌面**：只记你**和桌宠**的聊天。桌宠的对话不走 DSH 会话，插件每 60 秒读一次 `~/.dsh/dsh-pet/memory.json`，一问一答自动入账（按 ref 去重）；桌面上写代码、跑长任务这种会话**不进账本**
- **QQ**：每天固定时间（默认 23:50）结算一次，一天可以出多个话题；错过这个点也没关系——没结算的消息先落在 `pending.jsonl`，重启后自动补，日记同样会补上
- **B站**：插件每 5 分钟看一眼 `~/.dsh/whale-diary.md` 的 `## 看过` 表，一个视频自动入账一条（按 BV 去重，重复跑不会重复记）；她临时想补记也可以自己调 `diary_record`
- 寒暄、纯机械动作、「在吗」这类不写

## 检索

`diary_search` 走三级：

1. **主题**——先用已经长出来的主题锁范围
2. **关键词**——SQLite FTS5 + 中文 2-gram 预切词，词形变了也还能中
3. **语义**——本地向量（bge-small-zh，q8 约 24 MB）；没装模型时退回同义词典扩词，再不行就老实说没翻到

语义层是可选的：`@huggingface/transformers` 装不上、模型下不动、内存不够，插件照样能用，只是少了「同义改写」那一步召回。

## 工具

| 工具 | 干什么 |
|---|---|
| `diary_search` | 按主题 / 关键词 / 时间翻账 |
| `diary_record` | 手动记一条（看视频、聊完一件正事） |
| `diary_day` | 今天记了什么 |
| `diary_topic` | 某个主题的来龙去脉 |
| `diary_topics` | 主题榜 + B站 六个位置归谁 |
| `diary_journal` | 某天的日记 |
| `diary_detail` | 某条记录的详细内容 |
| `diary_reindex` | 给旧记录补向量（语义检索要用） |

### 补向量

向量是在**写入时**建的。从别处导入的历史记录、或者装插件之前就存在的记录，是没有向量的——它们只能被关键词搜到，同义改写搜不到。

插件启动 5 秒后会在后台自动补一批（默认 300 条，`backfillLimit` 可调，设 0 关掉），补完写 `~/.dsh/diary/semantic.json`，里面有 `added`（真补上的）、`failed` 和 `error`（失败原因）。连着失败会停，不会空转。想立刻补齐就调一次：

```
diary_reindex({ limit: 2000 })
```

模型文件要放在 `node_modules/@huggingface/transformers/.cache/Xenova/bge-small-zh-v1.5/`（`config.json`、`tokenizer.json`、`onnx/model_quantized.onnx`）。下不动的话可以从本机 engram 的模型目录复制过去，或者设 `HF_ENDPOINT` 换镜像再跑一次。

> 语义层不是必需的。补不补都不影响记账和关键词检索。

## 主题怎么长

- 认主题 = 名字或别名被提到（长的先匹配，避免「原神」吃掉「原神四」）
- 重要度 = `0.15 + 提得多的×0.55 + 你反应热的×0.30 + 新鲜度(7 天) + 她自评(≤0.40)`
- **AI 人格 / 虚拟陪伴** 永远排第一，固定占 B站 检索词的第一个位置，不参与另外 5 个位置的竞争
- 同物异名靠别名表合并，`mergeTopics` 会把边和别名一起搬走

## 可见性

- 桌面（桌宠聊天）+ **和主人**的 QQ 私聊 = `private`
- B站、QQ 群、其他人的私聊 = `public`
- 「谁是主人」由 `ownerQQ` 决定（见下面的配置）。**没配 `ownerQQ` 时，QQ 私聊一律按 `public` 记**——宁可少记私事，也不把陌生人的话写进私密账
- 公开视角下 `diary_search` / `diary_day` / `diary_topic` / `diary_detail` / `diary_journal` / `diary_topics` 都只返回 `public` 的东西：日记是当场按 public 条目重算的，不会把存下来的私人版端出去；只在私事里出现过的主题名也不会露

判定在**采集那一刻**做：改了 `ownerQQ` 只影响之后的记录，旧记录不会追溯改可见性。要改旧记录，直接改库里 `entries.vis`。

> 注意：这是**插件层**的闸。会话本身有文件系统权限的话，绕开工具直接读文件是拦不住的。真正的隔离要落在这台机器对那个会话的 ACL 上。

## 配置

`~/.dsh/diary/config.json`（全部可选）：

```json
{
  "idleMs": 600000,
  "qqSettleAt": "23:50",
  "journalAt": "23:58",
  "autoJournal": true,
  "semantic": true,
  "hfEndpoint": "https://hf-mirror.com",
  "embedModel": "Xenova/bge-small-zh-v1.5",
  "injectTopicHint": true,
  "ownerQQ": "你的 QQ 号",
  "catchupDays": 3,
  "biliWatch": true,
  "biliWatchPath": "",
  "biliWatchMs": 300000,
  "petWatch": true,
  "petMemoryPath": "",
  "petWatchMs": 60000,
  "desktopFromSessions": false,
  "minImp": 0.4,
  "minLen": 16,
  "thinkTake": true,
  "thinkTakeMs": 30000,
  "memoDebug": true
}
```

`ownerQQ` 是可见性的关键：只有这个号发来的 QQ 私聊会被记成 `private`，其他人的私聊、QQ 群、B站 都是 `public`。不填的话所有 QQ 私聊都按公开处理，启动日志里会提醒一句。

`catchupDays` 控制补跑范围：启动时和每 30 秒都会检查最近这几天有没有漏掉的 QQ 日结 / 日记，逐天补上；更老的就不追了，免得天天重试。

`biliWatch` 打开 B站 自动入账；`biliWatchPath` 空着就用 `~/.dsh/whale-diary.md`，`biliWatchMs` 是轮询间隔（默认 5 分钟）。入账规则：按 BV 去重，一个视频 = 一条记录（`ch=bili`、`vis=public`、`kind=watch`）+ 一个主题，标题里的书名号 / 方括号优先当成作品名（`《原神》…` → 主题「原神」），猜不出就退回标题第一段；BV、标题、UP、她的想法和原视频链接进详情层。她没写想法时记「看完了，没写下什么想法。」——不替她编。

`petWatch` 打开桌宠聊天入账；`petMemoryPath` 空着就用 `~/.dsh/dsh-pet/memory.json`（dsh-pet 自己的聊天记录），`petWatchMs` 是轮询间隔（默认 60 秒）。一问一答 = 一条 `ch=desktop`、`vis=private` 的记录，原话和她的回话进详情层，按 `ref` 去重，重复轮询不会写两遍。`desktopFromSessions` 默认 `false`：桌面上的 DSH 会话（写代码、跑长任务）不记账；设成 `true` 会退回旧行为，把每个桌面会话都结算进来——一般不需要。

`minImp` / `minLen` 是会话结算的记账门槛：一句话**够重**（`imp ≥ minImp`，答应/钱/踩坑这类）、**够长**（去噪后 ≥ `minLen` 字）、**或挂得上已有主题**，才写进账本；`继续`、`你看一下那个` 这种流水直接跳过，只在日志里记「跳过 N 条流水」。会话原文永远在 `~/.dsh/sessions/`，需要细节去翻原文或用 `diary_search`。想全收就设 `"minImp": 0, "minLen": 1`。注意门槛只管 QQ / 桌面会话结算；桌宠聊天和 B站 看过表照常入账（它们本来就是稀疏的、值得记的东西）。

`thinkTake` 控制「她自己的想法」怎么来：默认 `true`，每次结算（QQ 日结 / 补跑、桌宠轮询）时把这一批对话**一次**交给当前选中的模型，让它用第一人称各写一句（8–40 字）；模型没起来、超时（`thinkTakeMs`，默认 30 秒）、输出不是 JSON 数组，全部退回原来的规则截句，绝不让建模挡住入账。记录的 `take_src` 标了来源（`model` / `rule`），方便看出哪些是模型写的。`memoDebug` 默认 `true`，把每次问模型的过程写进 `~/.dsh/diary/think.log`（`start` / `ok` / `error` / `parse-fail` / `unusable` / `no-selection`），排错用；不想留日志就设 `false`。

## 注入

每轮主人开口时，如果这句话命中了已有主题，会把该主题最近 3 条挂到系统提示的末尾（`diary:topic`，order 1500），当作「这一轮可以用的储备」。没命中就不注入，不占 token。

## 已知限制

- 规则版不会从聊天里发明主题（认不出就留空），靠 `diary_record` 或后续模型提炼补；B站 那边会从标题里猜系列名，猜错也只会多一个主题
- 桌宠入账依赖 dsh-pet 的 `memory.json` 格式，那是它的私有文件；哪天格式变了，入账会安静地少收，不会报错
- 判不出反讽
- 空闲结算的启发式只对旧行为（`desktopFromSessions: true`）还成立，默认配置下桌面会话根本不进账本
- 语义层缺模型时退化成关键词 + 词典

## 自检

```bash
npm test
```

19 组断言：分词、脱敏、值得记的判定、她自己的想法、落库与检索、补向量、主题多对多、合并、置顶、重要度衰减、结算、记账门槛、模型想法（抠 JSON / 拼消息 / 失败退回）、可见性、语义兜底、补跑、B站 入账、桌宠入账、宿主接线。

## License

MIT
