# 更新日志

## 0.1.8 — 2026-11-02

**只记有分量的，不再把流水全存一遍**

- 会话结算加了记账门槛（`lib/settle.js` 的 `worthKeeping()`）：一句话**够重**（`imp ≥ minImp`，默认 0.4，答应/钱/踩坑这类）、**够长**（去噪后 ≥ `minLen`，默认 16 字）、**或挂得上已有主题**，才写进账本；`继续吧`、`你看一下那个` 这种流水跳过。配置项 `minImp` / `minLen`，设 `0 / 1` 退回全收。
- `settle()` 多一个 `stats` 出参（`{candidates, written, skipped}`），`flush()` 与 QQ 日结的日志会写「写入 N 条（跳过 M 条流水）」或「没有值得记的，跳过 M 条流水」。
- 门槛只管 QQ / 桌面会话结算；桌宠聊天（`lib/pet.js`）与 B站 看过表照常入账——那两路本来就稀疏，且是账本的核心内容。
- 测试加 1 组（18 组）：`settle-gate` 验证短流水被跳、长句进账、门槛调低后全收。

## 0.1.7 — 2026-11-02

**补向量不再假成功**

- `backfillVectors` 之前把失败也算成成功：`indexEntry` 返回 `false`（模型没加载起来）时仍然 `done++`，这批行永远补不进去，循环空转到上限，`semantic.json` 还写 `added: 300`。现在只计真正写进库的条数，连续失败 5 次就停，`semantic.json` 多记 `failed` 和 `error`，日志里也留一行。
- `diary_reindex` 的输出会报告失败条数和原因，不再只说「补了 N 条」。
- 语义模型找不到时要在 `node_modules/@huggingface/transformers/.cache` 里放好 `bge-small-zh-v1.5`（或用 `HF_ENDPOINT` 指镜像）；README 补了这条。

## 0.1.6 — 2026-11-02

**桌面只记桌宠聊天**

- 新增 `lib/pet.js`：读 `~/.dsh/dsh-pet/memory.json`，一问一答 = 一条记录（`ch=desktop`、`vis=private`、`source=pet`），按 `ref=pet:<宠物>/<对话>/<时间戳>` 去重；原话和回话进详情层，带情绪词记成 `mood`。
- `desktopFromSessions` 默认改为 `false`：桌面上的 DSH 会话（写代码、长任务）不再进账本；`true` 退回旧行为。
- 启动时跑一次，之后每 60 秒一轮；配置项 `petWatch` / `petMemoryPath` / `petWatchMs`。
- README、已知限制同步；测试加 1 组（17 组）：配对解析、寒暄跳过、去重、详情、启动入账、桌面会话不记账。

## 0.1.5 — 2026-11-02

**B站 自动入账**（REQUIREMENTS §12 第 1 项）

- 新增 `lib/bili.js`：解析 `~/.dsh/whale-diary.md` 的 `## 看过` 表格（按表头找「时间 / BV / 标题 / 想法」列，不依赖列顺序），每行视频入账一条。
- 一个视频 = 一条记录（`ch=bili`、`vis=public`、`kind=watch`、`source=bili`）+ 一个主题：先认已有主题，认不出就从标题猜系列名（`《原神》…` → 「原神」，`【猫meme】…` → 「猫meme」，否则取标题第一段）。
- 按 `ref=bili:<BV>` 去重，轮询重复跑不会重复记；BV、标题、UP、她的想法和原视频链接进详情层。
- 她没写想法时记「看完了，没写下什么想法。」，不替她编。
- 启动时跑一次，之后每 5 分钟一轮；配置项 `biliWatch` / `biliWatchPath` / `biliWatchMs`。
- 测试加 1 组（16 组）：表格解析、坏行跳过、主题派生、去重、详情落库、启动入账。

## 0.1.4 — 2026-11-02

**漏结算补跑**

- 未结算消息写穿到 `pending.jsonl`，启动时恢复；进程中途没了也不丢。
- 启动和每 30 秒检查最近 `catchupDays`（默认 3）天，逐天补 QQ 日结和日记，幂等可重复跑。
- `chName('internal')` 从「桌面」改成「内部」，日记抬头不再出现两条「桌面」。

## 0.1.3 — 2026-11-02

**可见性收紧**

- 启动把 `ownerQQ` 写进 `meta.owner_qq`；之前这个键从来没被写过，等于任何 QQ 私聊都能拿到全量私密视角。
- 统一 `visFor(sessionId, ownerQQ)`：桌面、和主人的 QQ 私聊 = `private`；B站、QQ 群、其他人的私聊 = `public`。没配 `ownerQQ` 时 QQ 一律 `public`。
- `diary_record` 复用同一判定；`diary_journal` / `diary_detail` / `diary_topics` 补齐公开视角过滤（日记按 public 条目现算，不端出存下来的私人版）。
- README 安装示例改 pin commit（`tarball/main` 会被 pnpm 缓存住）；启动成功后清掉过期的 `fatal.json`。

## 0.1.0 – 0.1.2 — 2026-11-01/02

初版：SQLite + FTS5 账本、entries / details / journal 三层、八个工具、主题网（别名合并、置顶、重要度衰减）、中英混合的语义检索（bge-small-zh，可选）、按主题注入系统提示、每日 JSONL 流水与备份。
