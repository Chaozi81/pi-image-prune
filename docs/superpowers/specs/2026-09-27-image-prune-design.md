# pi-image-prune — 请求级图片剪枝插件 设计

日期: 2026-09-27 · 状态: 已由用户逐节批准(第 1 节机制 / 第 2 节配置与工程)

## 1. 背景与问题

模型 `opencode-go/deepseek-v4.1-flash`(经 opencode.ai zen)在实际使用中, **单次请求里的图片超过 10 张时对话直接失败**。

现状核查:

- pi 的模型配置 schema 里**已有** `inputLimits.images.maxPerRequest` / `maxPerMessage`
  (`dist/core/model-config.d.ts`), 但 0.87.1 的实现里**只用了 `resize`**, 没有任何地方强制数量上限。
- 本机 `~/.pi/agent/models-store.json` 里 `deepseek-v4.1-flash` 的
  `inputLimits` 只有 `{ images: { resize: {...} } }`, 无数量上限。
- 图片进入会话的渠道: 用户在 TUI 粘贴/拖入; `pi --print "@a.png"` 位置参数附件;
  `read` 工具读图片文件(`dist/core/tools/read.js` 返回 `{type:"image",data,mimeType}` 内容块 + 一行
  `Read image file [image/png]` 文本)。

会话一旦攒够 11 张图, 之后每一轮请求都会带着这 11 张图 → 每一轮都失败, 会话实际上被卡死。

## 2. 目标

1. 单次请求里图片总数超过可配置上限时, **自动把最旧的图片挤出请求**, 使请求能正常发出。
2. 挤出的图片**落盘保存**, 占位文字里带上绝对路径, 模型需要时可用 `read` 工具重新查看(已验证
    `read` 对 png 返回图片内容块)。
3. **只改这一次请求**: 会话文件、`/session`、导出、计费都保持原始内容, 随时可换模型看到旧图。
4. 全局生效(manager 与所有子 agent), 默认上限 10, 可配置。
5. 任何内部故障都不许把请求弄挂: 失败即放行原消息(fail-open)。

## 3. 非目标

- 不做永久性上下文裁剪(不用 `context_edit`, 不写 `CompactionEntry`)。
- 不做图片压缩/转码(pi 已按 `inputLimits.images.resize` 处理)。
- 不改模型的 `inputLimits`、不改 provider、不改 pi 本体。
- 不做跨会话的图片去重/索引服务(内容寻址的落盘只是顺带得到的去重)。
- 不做"provider 报错后的大回合级补救"(如自动 `/compact`) —— 属于另一条需求。

## 4. 机制设计

### 4.1 挂载点

`pi.on("context", handler)`: 每次 LLM 调用前触发, `event.messages` 是**不含 system** 的会话消息;
返回 `{ messages }` 即替换本次请求内容, pi 在 handler 返回后会恢复 prompt/tool 状态。
存储层不受影响。

**不采用**:

- `before_provider_request` 改 payload: payload 是 `openai-completions` 的具体结构, 版本升级即碎。
  仅用它对**最终发出的图片数做只读兜底计数**(见 §4.6)。
- `context_edit` / `CompactionEntry`: 会永久改变会话投影, 与"只改本次请求"的目标相反。

### 4.2 计数与剪枝规则

1. 按顺序遍历 `messages`, 收集所有图片块, 得到有序列表 `found`。判定规则(唯一口径):
   只处理 `content` 为**数组**的消息; 数组元素是对象且 `type === "image"` 即算一张图片块。
   `content` 是字符串/其它类型的消息直接跳过(其中不可能有图片块)。
   缺少 `data` 字段的图片块**照常计数**(按 `String(data ?? "")` 计算哈希), 以保证计数与 provider 口径一致。
2. `found.length <= maxImages` → 返回 `undefined`(不新建数组、零改动、保持引用, 避免无谓的缓存抖动)。
3. 超出 → 从最旧的开始剪, 只保留**最新** `maxImages` 张。
4. 每个被剪掉的图片块**原地替换为等长的 text 块**:
   - 正常: `[早期图片已省略 · 超出单次请求上限 {max} 张 · 原图: {绝对路径}]`
   - 落盘失败: `[早期图片已省略 · 超出单次请求上限 {max} 张 · 落盘失败: {原因}]`
5. 消息数量、消息顺序、单个消息内的块数量与块顺序**均不得改变**。
6. **单条消息自身就超过上限**(例如一次粘贴 12 张): 只保留该消息内**最后** `maxImages` 张,
   并额外 notify 一次提醒"这一条本身就超了"。
7. **幂等**: 对已剪枝的结果再跑一次, 因为图片数已等于上限, 直接返回 `undefined`。
8. **确定性**: 同一张图在同一位置永远映射到同一段占位文字与同一落盘路径(路径由内容哈希派生),
   因此请求前缀稳定, prompt cache 只在"又多挤出一张"的那一刻失效一次。
9. 未改动的消息对象**按引用复用**, 只新建确实被改动的消息对象。
10. 不修改入参(不得 in-place 改写 `event.messages` 里的任何对象)。

### 4.3 落盘

- 路径: `<dumpDir>/YYYY-MM-DD/<sha256(base64)[:12]>.<ext>`
  - `ext` 由 `mimeType` 映射: `image/png→png`、`image/jpeg→jpg`、`image/webp→webp`、
    `image/gif→gif`、`image/bmp→bmp`; 其它/缺失 → `bin`
  - 日期取本地时区的当天
- 内容寻址: 落盘前先查进程内 `Set<hash>`, 再 `existsSync`; 命中则跳过写盘(同一张图只落一份)。
- 原子写: 先写 `.tmp-<pid>-<rand>`, `fsync` 后 `rename` 到目标路径; 失败清理临时文件。
- 权限: 目录 `0700`、文件 `0600`(截图可能含敏感信息)。
- 保留: `session_start` 时 best-effort 删除 mtime 早于 `retentionDays` 的**日期目录**;
  全程 try/catch, 任何失败只记警告, 不阻塞启动。
- 剪枝日志: 每次**实际发生剪枝**时, 向 `<dumpDir>/prune.log` 追加一行 JSONL:
  ```json
  {"ts":"2026-09-27T12:00:00.000Z","sessionId":"01a0...","maxImages":10,"totalImages":12,
   "pruned":[{"hash":"a1b2c3d4e5f6","path":"/abs/path.png"},{"hash":"...","path":null,"error":"EACCES"}]}
  ```
  写日志失败同样只记警告, 不影响剪枝结果。

### 4.4 配置

优先级: **环境变量 > 配置文件 > 内建默认**。

配置文件 `~/.pi/agent/image-prune.json`(不存在 = 全用默认):

```jsonc
{
  "enabled": true,
  "maxImages": 10,
  "dumpDir": "~/.pi/agent/image-prune",
  "retentionDays": 7
}
```

| 键 | 类型/取值 | 默认 | 校验 |
|---|---|---|---|
| `enabled` | boolean | `true` | 非 boolean → 该键回落默认 + 警告 |
| `maxImages` | 整数 ≥1 | `10` | 非法 → 回落默认 + 警告 |
| `dumpDir` | string | `~/.pi/agent/image-prune` | `~` 展开为 home; 相对路径按 home 解析 |
| `retentionDays` | 整数 ≥0 | `7` | `0` = 不清理; 非法 → 回落默认 + 警告 |

未知键忽略。非法 JSON → 全默认 + 一次警告。

环境变量:

| 变量 | 语义 |
|---|---|
| `PI_IMAGE_PRUNE` | `off/0/false/no` → 关闭剪枝; `on/1/true/yes` → 打开; 其它值 → 警告并忽略 |
| `PI_IMAGE_PRUNE_MAX` | 覆盖 `maxImages`(须为 ≥1 的整数) |
| `PI_IMAGE_PRUNE_DUMP_DIR` | 覆盖 `dumpDir`(端到端测试用) |

**关闭时的语义**(消除歧义): `context` handler 立即返回 `undefined`, **不剪枝、不落盘、不写 `prune.log`、不清理过期目录**;
§4.6 的只读兜底计数与警告**保留** —— 关闭状态下仍能发现"图片数已超限"。

读取时机: 扩展加载时读一次 + 每次 `session_start` 重读(改配置后新开会话即生效)。

**刻意不写** pi 的 `settings.json`: 该文件有 schema 校验, 塞自定义键有被拒风险; 独立配置文件最稳。

### 4.5 `/image-prune` 命令

| 命令 | 行为 |
|---|---|
| `/image-prune` | 显示生效配置(每个键标注来源 `env`/`file`/`default`) + 本会话统计(已剪张数、落盘个数、请求数、最近一次请求的图片总数) |
| `/image-prune max <n>` | 本会话内临时改上限(内存, 不写文件), 回显新值 |
| `/image-prune on` / `off` | 本会话内临时开关 |

非法参数 → 回显用法, 不抛异常。

### 4.6 观测兜底(只读)

`pi.on("before_provider_request")` 遍历最终 payload, 数出真正发出去的 `{type:"image"}` 个数;
若 > `maxImages` → notify 一次警告(每会话去重), 内容为
"仍有 N 张图超过上限, 可能来自其它扩展或 system prompt, 请报告"。
该 handler **不得改动 payload**。

### 4.7 错误处理(fail-open)

- 整个 `context` handler 包在 try/catch 中, 任何异常 → 返回 `undefined`(原样放行) + notify 一次警告。
- 落盘失败**不阻塞剪枝**: 仍剪掉图片, 占位文字写 `落盘失败: <原因>`。
- 配置读取失败 → 默认值 + 一次警告。
- 所有 notify 都限流, 规则是**每类提示每会话最多一次**。提示类别共四类:
  (a) 首次发生剪枝、
  (b) 单条消息自身超过上限、
  (c) §4.6 兜底计数发现仍有超限图片、
  (d) 落盘失败。
  剪枝本身**不每轮提示** —— 抛掉哪张图看 `prune.log` 与 `/image-prune` 统计,
  每轮刷屏的提示一律不发。

## 5. 测试

`node --test tests/*.test.ts`(与 `asset/pi-feed` 同构)。纯逻辑与 I/O 分离:
`lib/config.ts`、`lib/scan.ts`、`lib/prune.ts` 为纯函数(落盘通过注入的 callback, 不直接碰 fs),
`lib/dump.ts` 是唯一 I/O 模块。

必测用例:

- **config**: 无文件无环境变量 → 默认; 文件生效; env 优先级; `off`; 非法 JSON;
  `maxImages:0`/负数/非整数 → 回落默认 + 警告; `dumpDir` 的 `~` 展开。
- **scan**: 普通 user 消息; 工具结果里的图; 一条消息多个图块; `content` 非数组;
  空会话; 非图片块不受影响。
- **prune**: 恰好等于上限 → `undefined`(同一引用); 超 1 张 → 只剪最旧, 消息数/块数/顺序不变;
  跨消息保留最新 N 张; 单条内 12 张(上限 10) → 留该条最后 10 张; 幂等; 不改入参(快照对比);
  落盘抛错 → 仍剪 + 占位含"落盘失败"; 未改动消息按引用复用。
- **dump**: 同一内容两次 → 只写一份; 文件名由哈希派生且跨进程稳定; 未知 mime → `.bin`;
  无临时文件残留; 保留清理只删过期日期目录, 删不掉时不抛; `prune.log` JSONL 格式正确。

## 6. 端到端冒烟(核验用, 不由单测覆盖)

```bash
PI_IMAGE_PRUNE_MAX=3 PI_IMAGE_PRUNE_DUMP_DIR=/tmp/ip-smoke \
  pi -e /home/chaozi/桌面/learn/manager/asset/pi-image-prune \
     --print --no-session "最后一张图是什么颜色" @i1.png … @i12.png
```

断言: 请求成功; `/tmp/ip-smoke/prune.log` 有记录且 `pruned` 长度为 9; 落盘 9 个文件;
占位文字出现在 provider payload 里(用 `before_provider_request` 的临时日志或 `prune.log` 佐证)。

可选反证: 同命令**不加** `-e` → 观察 provider 是否真的拒绝(验证 §1 的前提)。

## 7. 工程结构

```
asset/pi-image-prune/                 ← 独立 git 仓库
├── README.md              用法 / 配置 / 限制 / 卸载
├── package.json           name=pi-image-prune, type=module,
│                          pi.extensions=["./extensions/index.ts"],
│                          scripts.test="node --test tests/*.test.ts"
├── .gitattributes         * text=auto eol=lf(对齐主仓库与 pi-feed)
├── .gitignore             node_modules/ 等
├── extensions/index.ts    仅装配: session_start / context / before_provider_request / 命令
├── lib/config.ts
├── lib/scan.ts
├── lib/prune.ts
├── lib/dump.ts
├── tests/{config,scan,prune,dump}.test.ts
└── docs/superpowers/specs/2026-09-27-image-prune-design.md
```

## 8. 装载与分工

- **装载**: 全局用户级 `pi install /home/chaozi/桌面/learn/manager/asset/pi-image-prune`
  → 写进 `~/.pi/agent/settings.json`, 本地路径按引用加载不拷贝; manager 与所有子 agent 都生效。
  **不写** manager 仓库的 `.pi/settings.json`(保持项目配置干净)。
  退路: 若 `pi install` 在本环境不可用, 直接在手写的 `settings.json` 里配置该绝对路径。
  卸载: `pi remove`。
- **全局级收尾(manager 自己做)**: `prompt/AGENTS.md` 项目清单加一行 `pi-image-prune`;
  `README.md` 提及; 全局安装; 验证结论沉淀到 `mermory/`。
- **项目级实现**: 派子 agent(`--cwd asset/pi-image-prune --profile code`)。

## 9. 风险与已知限制

1. **system prompt 里的图片不覆盖**: `context` 事件看不到 system 消息。pi 目前不往 system 塞图,
   由 §4.6 的兜底计数负责报警。
2. **handler 顺序**: 若其它扩展在我们的 handler **之后**才往 messages 里塞图, 本次计数不到 ——
   同样由 §4.6 兜底报警(不改行为)。
3. **prompt cache**: 首次剪枝与"又多挤出一张"时会失效该处之后的前缀; 属预期代价。
4. **磁盘占用**: 落盘图片按 `retentionDays` 清理; 若长期关闭清理需自行留意。
5. **单条消息内超限**时无法保留全部新图, 末尾 `maxImages` 张之外的图只能靠落盘路径找回。
6. **provider 侧其它限制**不覆盖(单张体积已由 pi 的 `resize` + `maxBytes` 管)。
7. 落盘图片可能含敏感内容 —— 目录/文件权限已收紧, 且默认 7 天清理。

## 10. 验收标准

1. `tests/` 四个测试文件全部通过(附原始输出)。
2. §6 端到端冒烟跑通(附 `prune.log` 与落盘目录 `ls` 输出)。
3. `git status` 干净、有初始 commit、`.gitattributes` 就位(全仓库已跟踪文件 CR 计数为 0)。
4. 报告明确列出未覆盖的风险。
