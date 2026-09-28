# pi-image-prune 实现计划

> **面向 AI 代理的工作者:** 逐任务实现此计划。步骤用复选框(`- [ ]`)跟踪进度;每个任务都以"先写失败测试 → 跑 → 写实现 → 跑 → commit"的循环收尾。设计真源: `docs/superpowers/specs/2026-09-27-image-prune-design.md`(下称"设计 §N")。

---

> ## ⚠️ 作废注记(实现前必读): 任务 4 的剪枝算法已被取代, **不要照它实现**
>
> 本文件是当时的过程记录, **其"任务 4"描述的剪枝算法已废弃**。任务 4 的算法原文含
> "每条消息各自保底 `maxImages` 张"的下限约束, 该约束已被判定为缺陷
> (两条消息各 12 张、上限 10 时, 剪后仍留 20 张 > 上限), 已由后续 commit 取代:
>
> - `bb77603` fix(prune): 剪枝改为**全局剪最旧的 `excess = refs.length - maxImages` 张, 硬保证剪后图片数 === `maxImages`**;
> - `4a0f64e` feat(prune): 新增 `maxImageBytes` 体积预算(默认 24 MiB, `0` = 关)。
>
> 被取代的具体点: 原文"每条消息各自保底 `maxImages` 张"这一约束**已删除**;
> 现为"**全局剪最旧的 excess 张, 硬保证剪后 === `maxImages`**", 并**新增了体积预算规则**
> (单条消息自身超限时, 该条自然只保留最后 `maxImages` 张, 不再是"保底")。
>
> **真源(一切以它们为准):**
> - 设计文档: `docs/superpowers/specs/2026-09-27-image-prune-design.md`(已订正: §1 前提、§4.2 规则 3/4/6、新增 §4.2.1 体积预算规则)
> - 现有代码: `lib/prune.ts` + `tests/prune.test.ts`(68 用例)
>
> 本文档其余历史内容保有当时原貌, 仅供追溯, 不作为实现依据。

---

**目标:** 实现 pi 扩展 `pi-image-prune`: 单次请求内图片数超过可配置上限(默认 10)时, 把最旧的图片落盘到 `~/.pi/agent/image-prune/YYYY-MM-DD/<sha12>.<ext>`, 并在原位置原地替换为带绝对路径的占位 text 块, 使请求能正常发出。只改本次请求, 存储层不变。全局生效(manager + 子 agent)。

**架构:** 纯逻辑与 I/O 分离。`lib/scan.ts`(定位图片块)、`lib/prune.ts`(决策 + 造新 messages, 落盘通过注入 callback)、`lib/config.ts`(配置解析) 都是纯函数, 可注入依赖、零 fs 零 pi;`lib/dump.ts` 是唯一 I/O 模块(哈希命名 + 原子写 + 保留清理 + prune.log);`extensions/index.ts` 只做事件接线(`session_start` / `context` / `before_provider_request` / `/image-prune` 命令)与限流提示。

**技术栈:** Node ≥22.18(原生 TS 直跑, 免编译)、`node --test`。**零运行时依赖、零 devDependency 必需**(扩展只 import type;不注册工具 → 不需要 typebox;不渲染 UI → 不需要 pi-tui, 与 pi-feed 不同)。本机 node 实测 `v22.23.3`。

**前置事实(已实测, 不需再验):**
- `pi.on("context", handler)` 每次 LLM 调用前触发, `event.messages` 是**不含 system** 的会话消息, 返回 `{ messages }` 即替换本次请求的内容; pi 在返回后恢复 prompt/tool。类型: `dist/core/extensions/types.d.ts:521`(`ContextEvent`)、`:991`(on 重载)、`:880`(`ContextEventResult = { messages?: AgentMessage[] }`)。
- pi 0.87.1 **声明但未强制** `inputLimits.images.maxPerRequest`: 全仓只有 `resize` 被使用(`dist/core/agent-session.js:281,1187`), 数量上限无人拦 → 必须插件自己剪。
- `read` 工具读图片返回 `{ type: "image", data, mimeType }` 内容块 + 一行文本 `Read image file [image/png]`(`dist/core/tools/read.js:75,88`)→ 落盘的图可被模型用 `read` 重新查看。
- pi CLI 的 `@path` 位置参数会作为附件图片进首条用户消息(`dist/cli/args.js:26,225` `fileArgs`)→ 可用 `pi --print ... @i1.png … @i12.png` 造出"单条消息 12 张图"。
- `pi.registerCommand(name, { description, handler })`, handler 签名 `(args: string, ctx)`(args 为命令后原文)。
- 图片块结构: `{ type: "image", data: string /* base64 */, mimeType: string }`(`docs/message-types.md:31`)。

**与设计文档的偏差:** 无。设计中"`lib/` 三纯函数 + 一个 I/O 模块"照实现: `lib/dump.ts` 同时导出纯命名函数(`hashImage`/`extForMime`/`dumpPath`, 供 `prune` 复用)与 I/O 工厂 `createDumper`。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `package.json` | 包元数据 + `pi.extensions` 清单 + `test` 脚本 | 创建 |
| `lib/dump.ts` | **纯** `hashImage`/`extForMime`/`dumpPath` + **I/O** `createDumper`(原子写、内容寻址去重、0700/0600、`pruneOld`、`log`) | 创建 |
| `lib/scan.ts` | **纯** `scanImages(messages)`: 按顺序找出所有图片块的位置 | 创建 |
| `lib/prune.ts` | **纯** `pruneImages(messages, deps)`: 决策 + 造新 messages + 占位文字; 落盘走注入 callback | 创建 |
| `lib/config.ts` | **纯** `resolveConfig({env, home, readFile})`: env > file > 默认, 出 `sources` 与 `warnings` | 创建 |
| `extensions/index.ts` | 装配: `session_start` / `context` / `before_provider_request` / `/image-prune` 命令; 四类限流提示; 会话统计 | 创建 |
| `tests/dump.test.ts` | 命名稳定性/去重/原子写/权限/保留清理/日志格式 | 创建 |
| `tests/scan.test.ts` | 图片定位的各种形状 | 创建 |
| `tests/prune.test.ts` | 剪枝规则全部用例(核心) | 创建 |
| `tests/config.test.ts` | 配置优先级与非法值回落 | 创建 |
| `README.md` | 用法 / 配置 / 限制 / 卸载 | 创建 |
| `.gitattributes` | 已存在(LF 归一) | 已有 |
| `.gitignore` | 已存在(`node_modules/`、`*.log`) | 已有 |

---

## 任务 1: 骨架 + `lib/dump.ts` 纯命名部分

**文件:** 创建 `package.json`、`lib/dump.ts`、`tests/dump.test.ts`

- [ ] **步骤 1: 建 `package.json`**

```json
{
  "name": "pi-image-prune",
  "version": "0.1.0",
  "description": "pi 扩展: 请求级图片剪枝 —— 单次请求图片超过上限时, 最旧的图片落盘并以路径占位",
  "type": "module",
  "private": true,
  "license": "MIT",
  "pi": { "extensions": ["./extensions/index.ts"] },
  "scripts": { "test": "node --test tests/*.test.ts" }
}
```

不需要 `npm install`(零依赖; 扩展只用 `import type`)。

- [ ] **步骤 2: 写失败测试** `tests/dump.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { hashImage, extForMime, dumpPath } from "../lib/dump.ts";

test("hashImage 稳定且为 12 位十六进制", () => {
  const a = hashImage("AAAA");
  assert.equal(a, hashImage("AAAA"));
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.notEqual(a, hashImage("BBBB"));
});

test("hashImage 对空/缺失输入不抛", () => {
  assert.match(hashImage(""), /^[0-9a-f]{12}$/);
  assert.equal(hashImage(""), hashImage(String(undefined ?? "")));
});

test("extForMime 映射与兜底", () => {
  assert.equal(extForMime("image/png"), "png");
  assert.equal(extForMime("image/jpeg"), "jpg");
  assert.equal(extForMime("image/webp"), "webp");
  assert.equal(extForMime("image/gif"), "gif");
  assert.equal(extForMime("image/bmp"), "bmp");
  assert.equal(extForMime("image/avif"), "bin");
  assert.equal(extForMime(undefined), "bin");
});

test("dumpPath 用本地日期分区, 路径可预测", () => {
  const now = new Date(2026, 8, 27, 23, 30, 0); // 本地时间 2026-09-27
  const p = dumpPath("/tmp/dump", "a1b2c3d4e5f6", "image/png", now);
  assert.equal(p, "/tmp/dump/2026-09-27/a1b2c3d4e5f6.png");
});
```

- [ ] **步骤 3: 跑测试确认失败**

```bash
cd /home/chaozi/桌面/learn/manager/asset/pi-image-prune && node --test tests/dump.test.ts
```
预期: `Cannot find module .../lib/dump.ts`(或 `hashImage is not a function`)。

- [ ] **步骤 4: 写实现(纯部分)** `lib/dump.ts`

```ts
import { createHash } from "node:crypto";

/** 内容寻址哈希: base64 原文 → sha256 十六进制前 12 位 */
export function hashImage(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex").slice(0, 12);
}

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp",
  "image/gif": "gif", "image/bmp": "bmp",
};

export function extForMime(mimeType: string | undefined): string {
  return (mimeType && EXT_BY_MIME[mimeType]) || "bin";
}

/** <dumpDir>/YYYY-MM-DD/<hash>.<ext>; 日期取本地时区 */
export function dumpPath(dumpDir: string, hash: string, mimeType: string | undefined, now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${dumpDir}/${y}-${m}-${d}/${hash}.${extForMime(mimeType)}`;
}
```

- [ ] **步骤 5: 跑测试确认通过**

```bash
node --test tests/dump.test.ts    # 预期 # pass 4
```

- [ ] **步骤 6: 提交**

```bash
git add package.json lib/dump.ts tests/dump.test.ts
git commit -m "feat(dump): 内容寻址命名 + 骨架 package.json"
```

---

## 任务 2: `lib/dump.ts` 的 I/O 部分

**文件:** 修改 `lib/dump.ts`; 修改 `tests/dump.test.ts`

**接口契约(照此实现):**

```ts
export interface Dumper {
  /** 写盘(内容寻址去重); 返回绝对路径或错误 */
  dump(img: { hash: string; data: string; mimeType?: string }): { path: string } | { error: string };
  /** best-effort 删除 mtime 早于 retentionDays 的日期目录; 0 = 不清理 */
  pruneOld(retentionDays: number): { removed: string[]; errors: string[] };
  /** 追加一行 JSONL 到 <dumpDir>/prune.log; 失败静默返回 false */
  log(line: Record<string, unknown>): boolean;
}
export function createDumper(opts: { dumpDir: string; now?: () => Date }): Dumper;
```

**行为要点(设计 §4.3):**
- 进程内 `Set<hash>` + `existsSync` 双查, 命中直接返回路径, 不写盘。
- 原子写: 目标目录 `mkdirSync(recursive, mode 0o700)`; 先写 `<dir>/.tmp-<pid>-<rand>`, `fsyncSync`, `renameSync`; 失败清理临时文件并返回 `{error}`。
- 文件 `mode: 0o600`(已存在的文件用 `chmodSync` 兜底)。
- `pruneOld`: 只遍历 `<dumpDir>` 下形如 `YYYY-MM-DD` 的目录, `mtime` 早于 `now - retentionDays*86400_000` 的递归删除; 单个失败进 `errors`, 不抛。
- `log`: 目标是 `<dumpDir>/prune.log`, `appendFileSync` + 一行一条 JSON; 失败返回 `false`(不抛)。

- [ ] **步骤 1: 写失败测试**(用 `node:fs` 的 `mkdtempSync` 建临时目录, 用 `node:test` 的 `t.after` 清理)

```ts
test("dump 写盘 + 同一内容只写一份", () => { /* 断言两次 dump 返回同一路径, 目录内文件数 == 1 */ });
test("dump 文件权限 0600、目录 0700", () => { /* statSync().mode & 0o777 */ });
test("dump 不残留临时文件", () => { /* 目录内无 .tmp-* */ });
test("dump 目标不可写时返回 error 而不抛", () => { /* dumpDir 指向一个已存在的普通文件路径 */ });
test("pruneOld 只删过期日期目录", () => { /* 造 2026-09-20 与 2026-09-26 两个目录, retentionDays=3, now=2026-09-27 → 只删前者 */ });
test("pruneOld retentionDays=0 什么都不删", () => {});
test("log 追加 JSONL, 每行可解析", () => {});
```

- [ ] **步骤 2: 跑测试确认失败** → `node --test tests/dump.test.ts`
- [ ] **步骤 3: 实现, 每写一个函数就跑一次测试**
- [ ] **步骤 4: 跑全量** → `node --test tests/*.test.ts`, 预期 `# pass 11`
- [ ] **步骤 5: 提交**

```bash
git add lib/dump.ts tests/dump.test.ts
git commit -m "feat(dump): 原子写 + 内容寻址去重 + 保留清理 + prune.log"
```

---

## 任务 3: `lib/scan.ts`

**接口契约:**

```ts
export interface ImageRef { msgIndex: number; blockIndex: number; data: string; mimeType?: string }
/** 按出现顺序返回所有图片块位置 */
export function scanImages(messages: readonly unknown[]): ImageRef[];
```

**判定规则(设计 §4.2 规则 1, 唯一口径):** 只处理 `content` 为**数组**的消息; 数组元素是对象且
`type === "image"` 即算一张(缺 `data` → 按 `String(data ?? "")` 处理); `content` 非数组的消息直接跳过。

- [ ] **步骤 1: 写失败测试** — 用例: 普通 user 消息里的图 / 工具结果消息里的图 / 一条消息两个图块(索引正确) / `content` 是字符串 / `content` 是 `undefined` / 空数组 / 非图片块(`text`/`thinking`/`toolCall`)不误判 / 缺 `data` 的 image 块仍被计入 / 顺序与嵌套顺序一致。
- [ ] **步骤 2: 跑测试确认失败**
- [ ] **步骤 3: 实现**(单次遍历, 不用递归, 只管 `messages[i].content[j]`)
- [ ] **步骤 4: 跑全量测试确认通过**
- [ ] **步骤 5: 提交** `feat(scan): 定位会话里的图片块`

---

## 任务 4: `lib/prune.ts`(核心)

> ⚠️ **本算法(含下方"各自保底"约束)已被 `bb77603` 取代(`4a0f64e` 又新增体积预算), 不要照下方旧算法实现** —— 见文首注记。现行为"全局剪最旧的 excess 张, 硬保证剪后 === `maxImages`"; 真源: 设计文档 + `lib/prune.ts` + `tests/prune.test.ts`。

**接口契约:**

```ts
export interface PrunedImage { hash: string; msgIndex: number; blockIndex: number; path: string | null; error?: string }
export interface PruneResult { messages: unknown[]; pruned: PrunedImage[]; totalImages: number; overLimitInSingleMessage: boolean }
export interface PruneDeps {
  maxImages: number;
  /** 落盘 callback; 由调用方注入(扩展注入 createDumper().dump, 测试注入 fake) */
  dump(img: { hash: string; data: string; mimeType?: string }): { path: string } | { error: string };
}
/** 未超限 → undefined(零改动、保持引用); 超限 → 新 messages + 剪枝明细 */
export function pruneImages(messages: readonly unknown[], deps: PruneDeps): PruneResult | undefined;
/** 占位文字(精确格式, 进单测) */
export function placeholderText(max: number, path: string | null, error?: string): string;
```

**算法(设计 §4.2):**

```ts
const refs = scanImages(messages);
if (refs.length <= deps.maxImages) return undefined;

// 需要剪掉的 = 全局最旧的 (refs.length - maxImages) 张
// 但同一消息内至多剪到"该消息只剩最后 maxImages 张"
const toPrune = new Set<ImageRef>();
for (const ref of refs.slice(0, refs.length - deps.maxImages)) toPrune.add(ref);
const overLimitInSingleMessage = /* 存在某条消息的图片数 > maxImages */;

// 逐消息重建: 只对含有 toPrune 的消息新建对象/新建 content 数组; 其余消息按引用复用
// 被剪的块 → { type: "text", text: placeholderText(...) }, 保持位置与块数不变
// dump 抛错 → catch 后 path=null, error=String(err), 占位文字写"落盘失败: …"(仍剪)
```

**必测用例(逐条对应设计 §4.2 / §5):**

- [ ] **步骤 1: 写失败测试** `tests/prune.test.ts`

```ts
const img = (data: string, mimeType = "image/png") => ({ type: "image", data, mimeType });
const user = (content: unknown) => ({ role: "user", content });
const fakeDump = (calls: string[]) => (i: { hash: string }) => { calls.push(i.hash); return { path: `/dump/${i.hash}.png` }; };

test("恰好等于上限 → undefined(同一引用)", () => {
  const msgs = [user([img("a"), { type: "text", text: "x" }])];
  const msgs10 = [user(Array.from({ length: 10 }, (_, i) => img(`i${i}`)))];
  assert.equal(pruneImages(msgs, { maxImages: 10, dump: fakeDump([]) }), undefined);
  assert.equal(pruneImages(msgs10, { maxImages: 10, dump: fakeDump([]) }), undefined);
});

test("超 1 张 → 只剪最旧, 消息数/块数/顺序不变", () => { /* 3 条消息各 4 张图, max=10 → 剪前 2 张, 断言 11 条长度不变、每块类型、占位文字含 /dump/ 路径 */ });
test("跨消息保留最新 N 张", () => { /* 断言被剪的正是全局最旧的 N 张, 最新的都在 */ });
test("不修改入参(快照对比)", () => { /* structuredClone 快照, 跑完深比较相等 */ });
test("未改动的消息按引用复用", () => { /* result.messages[1] === msgs[1] */ });
test("幂等: 对结果再跑一次 → undefined", () => {});
test("单条消息内 12 张(上限 10) → 留该条最后 10 张, overLimitInSingleMessage === true", () => {});
test("落盘抛错 → 仍剪, 占位含 '落盘失败', pruned[i].path === null 且带 error", () => {});
test("工具结果消息里的图同样被剪", () => { /* role: "toolResult" 形状的 content 数组 */ });
test("content 是字符串的消息原样复用", () => {});
test("dump 只对被剪的图调用", () => { /* 记录 calls, 断言数量与哈希集合 */ });
test("placeholderText 精确格式", () => {
  assert.equal(placeholderText(10, "/dump/a.png"), "[早期图片已省略 · 超出单次请求上限 10 张 · 原图: /dump/a.png]");
  assert.equal(placeholderText(10, null, "EACCES"), "[早期图片已省略 · 超出单次请求上限 10 张 · 落盘失败: EACCES]");
});
```

- [ ] **步骤 2: 跑测试确认失败**
- [ ] **步骤 3: 实现**
- [ ] **步骤 4: 跑全量测试确认通过**(预期此时 `# pass` ≥ 30)
- [ ] **步骤 5: 提交** `feat(prune): 请求级图片剪枝核心(保留最新 N 张 + 占位替换)`

---

## 任务 5: `lib/config.ts`

**接口契约:**

```ts
export interface Sources { enabled: Src; maxImages: Src; dumpDir: Src; retentionDays: Src }
export type Src = "env" | "file" | "default";
export interface ResolvedConfig {
  enabled: boolean; maxImages: number; dumpDir: string /* 绝对路径 */; retentionDays: number;
  sources: Sources; warnings: string[];
}
export const DEFAULTS: { enabled: true; maxImages: 10; dumpDir: "~/.pi/agent/image-prune"; retentionDays: 7 };
export function resolveConfig(opts?: {
  env?: NodeJS.ProcessEnv; home?: string; configPath?: string;
  readFile?: (p: string) => string;   // 测试注入; 默认 fs.readFileSync
}): ResolvedConfig;
```

**规则(设计 §4.4):** env > file > 默认; 逐键回落(非法键只影响自己); 非法 JSON → 全默认 + 1 条 warning;
`~` 展开为 home, 相对路径按 home 解析; `PI_IMAGE_PRUNE_MAX` 须为 ≥1 整数;
`PI_IMAGE_PRUNE=off/0/false/no` → `enabled:false`,`on/1/true/yes` → `true`, 其它 → warning + 忽略;
`PI_IMAGE_PRUNE_DUMP_DIR` 覆盖 `dumpDir`。每个键都要在 `sources` 里标注来源(供 `/image-prune` 显示)。

- [ ] **步骤 1: 写失败测试** — 用例: 无文件无 env → 全默认 + `sources` 全 `default`; 文件四键生效; env 覆盖 file; `PI_IMAGE_PRUNE=off`; `PI_IMAGE_PRUNE=maybe` → 默认 + warning; `maxImages: 0 / -1 / 1.5 / "10"` → 回落默认 + warning; 非法 JSON → 全默认 + warning; `dumpDir: "~/x"` → `<home>/x`; `dumpDir: "rel"` → `<home>/rel`; 未知键忽略且不产生 warning。
- [ ] **步骤 2: 跑测试确认失败** → **步骤 3: 实现** → **步骤 4: 全量测试** → **步骤 5: 提交** `feat(config): env > 文件 > 默认 的三层配置解析`

---

## 任务 6: `extensions/index.ts` 装配

**文件:** 创建 `extensions/index.ts`

**装配清单(设计 §4.5–§4.7):**

1. 模块级 `let cfg = resolveConfig()`、`let dumper = createDumper({ dumpDir: cfg.dumpDir })`、会话统计对象、`notified: Set<string>`。
2. `pi.on("session_start", ...)`: 重读配置、重建 dumper、清空 notified 与统计、`dumper.pruneOld(cfg.retentionDays)`(best-effort, 不 await 阻塞)。
3. `pi.on("context", async (event, ctx) => { ... })`:
   - `!cfg.enabled` → 立即 `return`(不剪枝/不落盘/不写日志/不清理, 设计 §4.4"关闭时的语义")。
   - 统计 `requests++`; 调 `pruneImages(event.messages, { maxImages: cfg.maxImages, dump: (i) => dumper.dump(i) })`。
   - 返回 `undefined` 时什么都不做(不 notify)。
   - 有剪枝 → 累加统计、`dumper.log({...})`(字段: `ts`/`sessionId`/`maxImages`/`totalImages`/`pruned[{hash,path,error?}]`)、按类提示一次; `return { messages: res.messages }`。
   - 整体 `try/catch` → 异常时提示一次并 `return`(fail-open, 设计 §4.7)。
4. `pi.on("before_provider_request", (event) => ...)`: 只读数一遍 payload 里的 `{type:"image"}` 个数; `> cfg.maxImages` → 提示一次(c 类)。**不得 return/修改 payload。**
5. `pi.registerCommand("image-prune", { description, handler })`:
   - 无参数 → 打印生效配置(每键带来源)+ 会话统计;
   - `max <n>` → 校验 ≥1 整数后改 `cfg.maxImages`(内存, 不写文件), 回显;
   - `on` / `off` → 改 `cfg.enabled`, 回显;
   - 其它 → 回显用法。用 `ctx.ui.notify(text, "info")` 输出。
6. 四类提示各每会话最多一次(设计 §4.7): `first-prune` / `single-message-over` / `payload-over` / `dump-failed`。

- [ ] **步骤 1: 写实现**(装配层不写单测: 纯逻辑已在任务 2–5 覆盖)
- [ ] **步骤 2: 模块可加载冒烟**

```bash
node -e "import('./extensions/index.ts').then(m => console.log(typeof m.default))"
```
预期: `function`(扩展只 import type, 无需 node_modules)。

- [ ] **步骤 3: 全量测试** → `node --test tests/*.test.ts`
- [ ] **步骤 4: 提交** `feat: 装配 context 剪枝 + /image-prune 命令 + 只读兜底计数`

---

## 任务 7: 端到端冒烟 + README

**文件:** 创建 `README.md`;临时脚本 `/tmp/ip-smoke/make-pngs.mjs`(**不提交**)

- [ ] **步骤 1: 造 12 张各不相同的合法 PNG**

```js
// /tmp/ip-smoke/make-pngs.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
const table = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, "ascii"), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
mkdirSync("/tmp/ip-smoke/imgs", { recursive: true });
for (let i = 1; i <= 12; i++) {
  const w = 8, h = 8, raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) { raw[y * (1 + w * 3)] = 0; for (let x = 0; x < w; x++) { const o = y * (1 + w * 3) + 1 + x * 3; raw[o] = i * 20; raw[o + 1] = x * 30; raw[o + 2] = y * 30; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  writeFileSync(`/tmp/ip-smoke/imgs/i${i}.png`, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}
console.log("12 pngs ok");
```

```bash
node /tmp/ip-smoke/make-pngs.mjs && ls /tmp/ip-smoke/imgs | wc -l   # 预期 12
# 12 张内容各不相同(哈希必须互异, 否则去重会让"落盘 9 个"断言失败):
for f in /tmp/ip-smoke/imgs/*.png; do sha256sum "$f"; done | awk '{print $1}' | sort -u | wc -l   # 预期 12
```

- [ ] **步骤 2: 端到端冒烟(设计 §6)**

```bash
cd /tmp/ip-smoke && rm -rf dump && PI_IMAGE_PRUNE_MAX=3 PI_IMAGE_PRUNE_DUMP_DIR=/tmp/ip-smoke/dump \
  timeout 300 pi -e /home/chaozi/桌面/learn/manager/asset/pi-image-prune --print --no-session \
  "最后一张图是什么颜色? 一句话回答" \
  @imgs/i1.png @imgs/i2.png @imgs/i3.png @imgs/i4.png @imgs/i5.png @imgs/i6.png \
  @imgs/i7.png @imgs/i8.png @imgs/i9.png @imgs/i10.png @imgs/i11.png @imgs/i12.png
echo "exit=$?"
```

断言(逐条附原始输出):
1. `exit=0` 且有文本回答(请求没被 provider 拒绝);
2. `cat /tmp/ip-smoke/dump/prune.log | tail -1` 是一行 JSON, `maxImages === 3`、`totalImages === 12`、`pruned` 长度 9;
3. `find /tmp/ip-smoke/dump -name '*.png' | wc -l` → 9(内容寻址去重后仍 9, 因为 12 张互异);
4. `ls -ld /tmp/ip-smoke/dump/$(date +%F)` 权限 `drwx------`(0700);
5. 占位文字确实进了 provider payload —— 临时在 `extensions/index.ts` 外用最小脚本验证: 用 jiti/node 直接调 `pruneImages` 的输出断言占位文字形态已在任务 4 单测覆盖;端到端只需确认"剪枝真的发生了"(第 2、3 条)即可, 不必解析 payload。

- [ ] **步骤 3: 可选反证(验证前提, 允许失败/跳过)** — 同命令**不加** `-e`:若 provider 真的拒绝, 记录报错原文与退出码;这佐证设计 §1 的前提。失败即跳过, 不算本任务未完成。

- [ ] **步骤 4: 写 `README.md`** — 必须包含: 一句话作用; 为什么需要(provider 10 张上限, pi 声明但未强制 `maxPerRequest`); 配置表(文件键 + 三个环境变量 + 优先级); 落盘位置/权限/保留策略; `/image-prune` 命令用法; 已知限制(引设计 §9 摘要); 卸载方式(`pi remove`, 或从 `~/.pi/agent/settings.json` 移除条目); **明确写"本项目不会被写入 manager 仓库的 `.pi/settings.json`"**。

- [ ] **步骤 5: 终检 + 提交**

```bash
node --test tests/*.test.ts          # 全绿
git status --short                   # 干净(允许 node_modules/ 与 /tmp 脚本不在仓库内)
git ls-files | xargs grep -lc $'\r'  # 只应列出 0 字节命中的文件; 无 CRLF
git add README.md && git commit -m "docs: README(用法/配置/限制/卸载)"
git log --oneline | cat
```

- [ ] **步骤 6: 回传报告**(用任务指令块里的 `bin/pi-feed.sh add --kind report --source pi-img-prune ...`), 报告须含: 上述每条命令的原始输出与退出码; 未覆盖风险清单。

---

## 自检记录

**规格覆盖度(对照设计 §1–§10):**

| 设计节 | 落在 |
|---|---|
| §4.1 挂载点 `context` | 任务 6 |
| §4.2 计数与剪枝规则 1–10 | 任务 3(口径)+ 任务 4(规则 2–10)+ 单测逐条 |
| §4.3 落盘(路径/去重/原子写/权限/保留/日志) | 任务 1(命名)+ 任务 2(I/O) |
| §4.4 配置(三层/校验/关闭语义) | 任务 5 + 任务 6 步骤 3 |
| §4.5 `/image-prune` 命令 | 任务 6 |
| §4.6 只读兜底计数 | 任务 6 |
| §4.7 fail-open 与四类限流提示 | 任务 4(落盘失败不阻塞)+ 任务 6 |
| §5 测试清单 | 任务 2–5 的用例 |
| §6 端到端冒烟 | 任务 7 |
| §7 工程结构 | 文件结构表 |
| §8 装载 | 不在本计划内 —— 由 manager 全局级收尾(`pi install` + AGENTS.md + README) |
| §10 验收标准 | 任务 7 步骤 5/6 |

**占位符扫描:** 无 TODO/待定;每个任务都有可执行命令与预期输出。

**类型一致性:** `ImageRef`(任务 3 定义)被 `lib/prune.ts` 与 `PrunedImage` 复用;`Dumper.dump` 的返回类型
`{path}|{error}` 与 `PruneDeps.dump` 完全同形, 扩展里可直接传 `(i) => dumper.dump(i)`;`resolveConfig` 的
`ResolvedConfig.maxImages` 被任务 6 的命令改写(仅内存)。

**执行交接:** 逐任务执行, 每个任务结束跑 `node --test tests/*.test.ts` 确认全绿再进入下一任务;
不要 push; 不要修改设计文档; 遇到设计与实测冲突 → 先记进报告, 不要擅自改设计。
