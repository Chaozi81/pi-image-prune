# pi-image-prune — 请求级图片剪枝插件 设计

日期: 2026-09-27 · 状态: 已由用户逐节批准(第 1 节机制 / 第 2 节配置与工程)

## 1. 背景与问题

模型 `opencode-go/deepseek-v4.1-flash`(经 opencode.ai zen)在实际使用中, 单次请求里的图片过多时
**请求被上游拒绝 / 卡死**。实测 provider 报错原文(取自本机会话 JSONL 的 `errorMessage`):

```text
400 invalid_request_error: Upstream request failed: [invalid_request_error] Too many images in request: 31 > 30
400 invalid_request_error:          … a request may include at most 20 images
```

由此得到两条**实测事实**:

- **事实 A1**: 图片数量上限**随上游路由不同而变**(实测 20 / 30), 不是固定 10, 也不是 600。
  那次报错的请求里实际有 **31 张图**。
- **事实 A2**: 该会话里 **53 个图片块全部位于 `toolResult` 消息**(每次 `read` 一个图片文件 = 1 张),
  没有一张来自用户粘贴。实测报错还有 `Request timed out` / `Aborted after 1 retry attempt` ——
  用户感受到的"对话直接失败/卡住"由 pi 重试后中断造成。

模型/API 文档口径(来源 = 用户提供的限制表):

| 限制项 | 数值 |
|---|---|
| 支持格式 | JPEG、PNG、GIF、WebP |
| 外部 URL 长度 | 8192 字符 |
| 请求体大小 | **48 MiB** |
| 单张图片最大(base64/外部 URL) | 32 MiB |
| 单张图片最大(Files API file_id) | 64 MiB |
| **单个请求最大图片数** | 600 |
| 单个请求图片总大小 | 不含 file_id 最多 **64 MiB**; 含 file_id 最高 200 MiB |
| 图片最大尺寸 | 单边 ≤8192px; **请求含 ≥15 张图时降为 4096px** |

**600 是"上限的上限"**(文档层面), 实际能过与否取决于当次命中的上游 —— 即事实 A1 的 20/30。

pi 侧已知(本机 `deepseek-v4.1-flash` 的 `inputLimits.images.resize` =
`{maxWidth:2000, maxHeight:2000, maxBytes:4718592, jpegQuality:80}`):

- 单边 2000px < 4096px → 文档中"≥15 张时降为 4096px"那条**天然满足**, 不需要代码。
- 但每张 ≤4.5 MiB, base64 膨胀 4/3 后 ≈6 MiB/张 → **8 张大截图就能顶到 48 MiB 请求体**。
  这就是只数张数拦不住的**体积盲区**, 也是本设计新增 `maxImageBytes` 的直接原因。
- 补充实测: pi 在 `context` 事件**之前**就会归一化/缩放图片 —— 11.45 MiB 的 2000×2000 PNG
  到 `context` 时每张只剩 ≈2.2 MiB(平滑内容)。因此体积规则估算的是**归一化之后**的 base64。

现状核查:

- pi 的模型配置 schema 里**已有** `inputLimits.images.maxPerRequest` / `maxPerMessage`
  (`dist/core/model-config.d.ts`), 但 0.87.1 的实现里**只用了 `resize`**, 没有任何地方强制数量上限。
- 本机 `~/.pi/agent/models-store.json` 里 `deepseek-v4.1-flash` 的
  `inputLimits` 只有 `{ images: { resize: {...} } }`, 无数量上限。
- 图片进入会话的渠道: 用户在 TUI 粘贴/拖入; `pi --print "@a.png"` 位置参数附件;
  `read` 工具读图片文件(`dist/core/tools/read.js` 返回 `{type:"image",data,mimeType}` 内容块 + 一行
  `Read image file [image/png]` 文本)。

会话一旦攒够超限的图片(数量或体积), 之后每一轮请求都会带着这些图 → 每一轮都失败, 会话实际上被卡死。

## 2. 目标

1. 单次请求里图片总数超过可配置张数上限, **或图片估算总体积超过可配置字节预算**时,
   **自动把最旧的图片挤出请求**, 使请求能正常发出。两条规则同时生效, 取更严者;
   张数规则硬保证剪后张数 === `maxImages`, 体积规则硬保证至少留最新 1 张。
2. 挤出的图片**落盘保存**, 占位文字里带上绝对路径, 模型需要时可用 `read` 工具重新查看(已验证
    `read` 对 png 返回图片内容块)。
3. **只改这一次请求**: 会话文件、`/session`、导出、计费都保持原始内容, 随时可换模型看到旧图。
4. 全局生效(manager 与所有子 agent), 默认张数上限 10、体积预算 24 MiB, 均可配置。
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
3. 超出 → 从**全局最旧**的开始剪, 只保留**最新** `maxImages` 张。**硬保证**: 剪枝后图片数恒等于 `maxImages`。
4. 每个被剪掉的图片块**原地替换为等长的 text 块**(两种规则措辞不同):
   - 张数规则正常: `[早期图片已省略 · 超出单次请求上限 {max} 张 · 原图: {绝对路径}]`
   - 张数规则落盘失败: `[早期图片已省略 · 超出单次请求上限 {max} 张 · 落盘失败: {原因}]`
   - 体积规则正常: `[早期图片已省略 · 超出单次请求体积预算 {预算 MiB} · 原图: {绝对路径}]`
   - 体积规则落盘失败: `[早期图片已省略 · 超出单次请求体积预算 {预算 MiB} · 落盘失败: {原因}]`
5. 消息数量、消息顺序、单个消息内的块数量与块顺序**均不得改变**。
6. **全局保留最新 `maxImages` 张是硬保证**。单条消息自身超限时, 该条自然只保留最后 `maxImages` 张;
   多条消息同时超限时优先保最新。`overLimitInSingleMessage` 仍计算(用于提示), 但**不再影响**剪枝结果。
   (旧实现给每条消息各自保底 `maxImages` 张, 导致两条各 12 张、上限 10 时剪后仍有 20 张 —— 已修正。)
7. **幂等**: 对已剪枝到上限、且体积已 <= 预算的结果再跑一次, 因为两条规则均不再触发, 直接返回 `undefined`。
8. **确定性**: 同一张图在同一位置永远映射到同一段占位文字与同一落盘路径(路径由内容哈希派生),
   因此请求前缀稳定, prompt cache 只在"又多挤出一张"的那一刻失效一次。
9. 未改动的消息对象**按引用复用**, 只新建确实被改动的消息对象。
10. 不修改入参(不得 in-place 改写 `event.messages` 里的任何对象)。

#### 4.2.1 体积预算规则(`maxImageBytes`)

1. **单张体积估算**: `Math.ceil(String(data ?? "").length * 3 / 4)`(base64 文本 → 二进制字节)。
   这是**偏保守的估算**: **不含 JSON 结构开销**(引号/字段名/转义), 所以默认预算取
   provider 请求体上限 48 MiB 的**一半** = 24 MiB(`25165824`)。
2. **与张数规则同时生效, 取更严者**: 先跑张数规则, 得到保留集合与 `keptBytes`;
   然后**只要 `keptBytes > maxImageBytes` 且 `keptCount > 1`, 就继续剪掉最旧的一张**(仍全局最旧优先),
   直到达标。
3. **永远至少保留最新的 1 张**: `keptCount === 1` 时停手 —— 宁可超预算也不把请求剪空。
4. 若最终 `keptCount === 1` 且该张自身仍 > 预算 → `PruneResult.singleImageOverBudget = true`,
   扩展侧发一次提示(类别 e), 但**不处理该张**。
5. `maxImageBytes === 0` → 体积规则**完全关闭**(不做任何体积裁剪, `singleImageOverBudget` 恒为 `false`)。
6. 被剪张数入 `pruned[].reason`: `"count"`(张数规则)或 `"bytes"`(体积规则)。
   由于两条规则都只剪最旧前缀, `pruned[]` 天然是"最旧的先剪", 且 `count` 项一定在 `bytes` 项之前。
7. 体积数值显示格式: 字节 → `MiB`, 最多 1 位小数、去掉多余的 `.0`
   (例: `25165824 → "24 MiB"`、`524288 → "0.5 MiB"`、`2621440 → "2.5 MiB"`)。
8. `PruneResult` 新增字段: `totalBytes`、`keptBytes`、`keptImages`、`singleImageOverBudget`。

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
- 剪枝日志: 每次**实际发生剪枝**(`pruned.length > 0`)时, 向 `<dumpDir>/prune.log` 追加一行 JSONL:
  ```json
  {"ts":"2026-09-27T12:00:00.000Z","sessionId":"01a0...","maxImages":10,"maxImageBytes":25165824,
   "totalImages":12,"totalBytes":57307770,"keptBytes":8788419,
   "pruned":[{"hash":"a1b2c3d4e5f6","path":"/abs/path.png","reason":"count"},
             {"hash":"...","path":null,"error":"EACCES","reason":"bytes"}]}
  ```
  写日志失败同样只记警告, 不影响剪枝结果。

### 4.4 配置

优先级: **环境变量 > 配置文件 > 内建默认**。

配置文件 `~/.pi/agent/image-prune.json`(不存在 = 全用默认):

```jsonc
{
  "enabled": true,
  "maxImages": 10,
  "maxImageBytes": 25165824,
  "dumpDir": "~/.pi/agent/image-prune",
  "retentionDays": 7
}
```

| 键 | 类型/取值 | 默认 | 校验 |
|---|---|---|---|
| `enabled` | boolean | `true` | 非 boolean → 该键回落默认 + 警告 |
| `maxImages` | 整数 ≥1 | `10` | 非法 → 回落默认 + 警告 |
| `maxImageBytes` | 整数 ≥0(字节) | `25165824`(24 MiB) | `0` = 关闭体积规则; 非法 → 回落默认 + 警告 |
| `dumpDir` | string | `~/.pi/agent/image-prune` | `~` 展开为 home; 相对路径按 home 解析 |
| `retentionDays` | 整数 ≥0 | `7` | `0` = 不清理; 非法 → 回落默认 + 警告 |

未知键忽略。非法 JSON → 全默认 + 一次警告。

环境变量:

| 变量 | 语义 |
|---|---|
| `PI_IMAGE_PRUNE` | `off/0/false/no` → 关闭剪枝; `on/1/true/yes` → 打开; 其它值 → 警告并忽略 |
| `PI_IMAGE_PRUNE_MAX` | 覆盖 `maxImages`(须为 ≥1 的整数) |
| `PI_IMAGE_PRUNE_MAX_BYTES` | 覆盖 `maxImageBytes`(须为 ≥0 的整数; `0` 合法 = 关闭体积规则) |
| `PI_IMAGE_PRUNE_DUMP_DIR` | 覆盖 `dumpDir`(端到端测试用) |

**关闭时的语义**(消除歧义): `context` handler 立即返回 `undefined`, **不剪枝、不落盘、不写 `prune.log`、不清理过期目录**;
§4.6 的只读兜底计数与警告**保留** —— 关闭状态下仍能发现"图片数已超限"。

读取时机: 扩展加载时读一次 + 每次 `session_start` 重读(改配置后新开会话即生效)。

**刻意不写** pi 的 `settings.json`: 该文件有 schema 校验, 塞自定义键有被拒风险; 独立配置文件最稳。

### 4.5 `/image-prune` 命令

| 命令 | 行为 |
|---|---|
| `/image-prune` | 显示生效配置(每个键标注来源 `env`/`file`/`session`/`default`) + 本会话统计(已剪张数、落盘个数、请求数、最近一次请求的图片总数) |
| `/image-prune max <n>` | 本会话内临时改张数上限(内存, 不写文件), 回显新值 |
| `/image-prune bytes <n>[MiB]` | 本会话内临时改体积预算: `n` 为纯字节数或 `<n>MiB`(不区分大小写); `0` = 关闭体积规则 |
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
- 所有 notify 都限流, 规则是**每类提示每会话最多一次**。提示类别共五类:
  (a) 首次发生剪枝(仅在 `pruned.length > 0` 时发)、
  (b) 单条消息自身超过上限、
  (c) §4.6 兜底计数发现仍有超限图片、
  (d) 落盘失败、
  (e) 单张图自身超过体积预算(`singleImageOverBudget`, 只提示不处理)。
  剪枝本身**不每轮提示** —— 抛掉哪张图看 `prune.log` 与 `/image-prune` 统计,
  每轮刷屏的提示一律不发。

## 5. 测试

`node --test tests/*.test.ts`(与 `asset/pi-feed` 同构)。纯逻辑与 I/O 分离:
`lib/config.ts`、`lib/scan.ts`、`lib/prune.ts` 为纯函数(落盘通过注入的 callback, 不直接碰 fs),
`lib/dump.ts` 是唯一 I/O 模块。

必测用例:

- **config**: 无文件无环境变量 → 默认; 文件生效; env 优先级; `off`; 非法 JSON;
  `maxImages:0`/负数/非整数 → 回落默认 + 警告; `dumpDir` 的 `~` 展开;
  `maxImageBytes` 默认 `25165824`、文件值、env 覆盖、非法值回落、`0` 合法(文件与 env 两路)。
- **scan**: 普通 user 消息; 工具结果里的图; 一条消息多个图块; `content` 非数组;
  空会话; 非图片块不受影响。
- **prune**: 恰好等于上限 → `undefined`(同一引用); 超 1 张 → 只剪最旧, 消息数/块数/顺序不变;
  跨消息保留最新 N 张; 单条内 12 张(上限 10) → 留该条最后 10 张; 幂等; 不改入参(快照对比);
  落盘抛错 → 仍剪 + 占位含"落盘失败"; 未改动消息按引用复用。
  **回归/语义变更用例**:
  - 两条消息各 12 张、上限 10 → 剪后**恰好 10 张**、`pruned.length === 14`(修前是 20 张, 会失败);
  - 一条 12 张 + 后面 1 张新的、上限 10 → 保留**最新 10 张**(前一条最后 9 张 + 新的 1 张);
  - 多条消息同时超限 → 全局剪最旧, 剪后总数 === `maxImages`。
  **体积规则用例**: 张数不超但体积超 → 按体积剪到 <= 预算且至少留 1 张;
  预算很小时 `singleImageOverBudget === true`; 只有 1 张且自身超预算 → 无可剪但仍返回结果并标记;
  `maxImageBytes=0` → 体积规则完全不生效; 张数与体积同时超 → 两种 `reason` 都出现且最旧的先剪;
  体积规则落盘抛错 → 占位含"落盘失败"; `formatMiB`/`estimateBytes` 边界。
- **dump**: 同一内容两次 → 只写一份; 文件名由哈希派生且跨进程稳定; 未知 mime → `.bin`;
  无临时文件残留; 保留清理只删过期日期目录, 删不掉时不抛; `prune.log` JSONL 格式正确。

## 6. 端到端冒烟(核验用, 不由单测覆盖)

一律用 `timeout` + `--print --no-session`, `PI_IMAGE_PRUNE_DUMP_DIR` 指向 `/tmp` 下目录; 不起交互式 pi。

### 6.1 张数冒烟(12 张小图)

```bash
PI_IMAGE_PRUNE_MAX=3 PI_IMAGE_PRUNE_DUMP_DIR=/tmp/ip-smoke/dump \
  timeout 300 pi -e /home/chaozi/桌面/learn/manager/asset/pi-image-prune \
     --print --no-session "最后一张图是什么颜色" @i1.png … @i12.png
```

断言: 请求成功(exit=0); 首个请求的 `prune.log` 行 `totalImages=12`、`pruned` 长度 9;
落盘 9 个文件; 后续请求因模型用 `read` 又读入图片而变成 13 张 → 剪 10 张(仍 <= `maxImages`)。

### 6.2 体积冒烟(大图 + `maxImageBytes`)

```bash
PI_IMAGE_PRUNE_MAX=10 PI_IMAGE_PRUNE_MAX_BYTES=20971520 PI_IMAGE_PRUNE_DUMP_DIR=/tmp/ip-smoke/dump-big \
  timeout 300 pi -e /home/chaozi/桌面/learn/manager/asset/pi-image-prune \
     --print --no-session "这些图有图案吗" @b1.png … @b10.png
```

断言: 请求成功; `prune.log` 末行含 `reason: "bytes"` 的条目, 且 `keptBytes <= 20971520`。

**实测要点(重要)**: pi 在 `context` 事件**之前**已归一化图片。11.45 MiB 的 2000×2000 PNG
到 `context` 时每张只剩 ≈2.2 MiB(平滑内容)。所以:
- **3 张图无法触发 20 MiB 预算**(归一化后合计 ≈6.7 MiB), 必须用更多张(实测 10 张 → 22.55 MiB)才能触发;
- **纯随机噪声图不适合冒烟**: 高熵内容经 pi 重编码后仍然很大, provider 会挂起(与剪枝无关,
  关闭扩展同样挂起); 应使用"文件很大但内容平滑"的 PNG(例: `deflate level 0` 存 2000×2000 渐变),
  这样体积估算够大, 而 pi 重编码后 provider 能接受。

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
5. **单条消息内超限**时无法保留全部新图: 全局规则下该条自然只保留最后 `maxImages` 张,
   其余只能靠落盘路径找回。
6. **单张图自身超预算只提示不处理**: 当 `keptCount === 1` 且该张仍 > 预算时,
   发一次提示(类别 e)但不剪掉它(宁可超预算也不把请求剪空)。
   特例: 若整个请求**只有这一张图**, 因无剪枝发生, 连提示也不会发。
7. **未覆盖: 文本与工具输出的体积**: `maxImageBytes` 只算图片块; 巨大的文本/工具输出不计入。
8. **未覆盖: file_id 类图片**: pi 不使用 Files API 的 `file_id`, 本扩展也不处理。
9. **体积是估算**: 公式为 base64 长度 × 3/4, **不含 JSON 结构开销**(引号/字段名/转义),
   也不含文本块。默认 24 MiB 是 48 MiB 请求体上限的一半, 留了一半余量。
10. **估算基于 pi 归一化之后的图片**: pi 在 `context` 之前会缩放/重编码图片,
    所以预算实际约束的是归一化后的 base64 体积(实测 11.45 MiB PNG → ≈2.2 MiB)。
11. **provider 侧其它限制**不覆盖(如上游路由的临时差异; 单张体积已由 pi 的 `resize` + `maxBytes` 管)。
12. 落盘图片可能含敏感内容 —— 目录/文件权限已收紧, 且默认 7 天清理。

## 10. 验收标准

1. `tests/` 四个测试文件全部通过(附原始输出); 优先级回归用例在**修前失败、修后通过**均有记录。
2. §6 端到端冒烟跑通: 张数冒烟 + 体积冒烟(附 `prune.log` 关键字段与断言结果)。
3. 真实数据回放(manager 会话 JSONL, 53 张图全在 `toolResult`)满足:
   剪后图片数 = `maxImages`、`keptBytes <= maxImageBytes`、消息数与入参图片块数不变。
4. `git status` 干净、有分步 commit、`.gitattributes` 就位(全仓库已跟踪文件 CR 计数为 0)。
5. 报告明确列出未覆盖的风险与偏差。
