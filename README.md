# pi-image-prune

pi 扩展：**请求级图片剪枝** —— 单次请求里的图片数超过可配置上限（默认 10），或图片估算总体积超过可配置预算（默认 24 MiB）时，自动把**最旧的**图片落盘到本地并以带绝对路径的占位文字替换，让请求能正常发出。

## 为什么需要

模型经 opencode.ai zen 调用时，单次请求里的图片过多会导致请求被上游拒绝或卡死。实测 provider 报错原文（取自本机会话 JSONL 的 `errorMessage`）：

```text
400 invalid_request_error: Upstream request failed: [invalid_request_error] Too many images in request: 31 > 30
400 invalid_request_error:          … a request may include at most 20 images
```

两条实测事实：

- 图片数量上限**随上游路由不同而变**（实测 20 / 30），不是固定 10，也不是 600；那次报错的请求里实际有 **31 张图**。
- 该会话里 **53 个图片块全部位于 `toolResult` 消息**（每次 `read` 一个图片文件 = 1 张），没有一张来自用户粘贴；实测报错还有 `Request timed out` / `Aborted after 1 retry attempt`。

模型/API 文档口径（来源 = 用户提供的限制表）：

| 限制项 | 数值 |
| --- | --- |
| 支持格式 | JPEG、PNG、GIF、WebP |
| 外部 URL 长度 | 8192 字符 |
| 请求体大小 | **48 MiB** |
| 单张图片最大（base64/外部 URL） | 32 MiB |
| 单张图片最大（Files API file_id） | 64 MiB |
| **单个请求最大图片数** | 600 |
| 单个请求图片总大小 | 不含 file_id 最多 **64 MiB**；含 file_id 最高 200 MiB |
| 图片最大尺寸 | 单边 ≤8192px；**请求含 ≥15 张图时降为 4096px** |

**600 是「上限的上限」**（文档层面），实际能否通过取决于当次命中的上游，即实测的 20/30。

pi 的模型配置 schema 里**已有** `inputLimits.images.maxPerRequest`，但 pi 0.87.1 的实现里只用到 `resize`，**没有任何地方强制数量上限**（本机 `deepseek-v4.1-flash` 的 `inputLimits` 只有 `resize`）。会话一旦攒够超限的图片，之后每一轮请求都会带着这些图 → 每一轮都失败，会话实际上被卡死。

单边 2000px < 4096px，所以文档里「≥15 张时降为 4096px」那条天然满足。但每张 ≤4.5 MiB、base64 膨胀 4/3 后 ≈6 MiB/张 → **8 张大截图就能顶到 48 MiB 请求体**，这是只数张数拦不住的**体积盲区**，也是新增 `maxImageBytes` 的直接原因。

本扩展在 `context` 事件（每次 LLM 调用前触发，`event.messages` 不含 system）里把超限的图片挤出去，**只改这一次请求**：

- 会话文件、`/session`、导出、计费都保持原始内容；
- 落盘的图可用 `read` 工具重新查看（pi 的 `read` 对 png 返回图片内容块）；
- 任何内部故障都 fail-open：出错就把原消息原样放行。

## 配置

**优先级：环境变量 > 配置文件 > 内建默认。**

### 配置文件 `~/.pi/agent/image-prune.json`（不存在 = 全用默认）

```jsonc
{
  "enabled": true,
  "maxImages": 10,
  "maxImageBytes": 25165824,
  "dumpDir": "~/.pi/agent/image-prune",
  "retentionDays": 7
}
```

| 键 | 类型 / 取值 | 默认 | 校验 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 非 boolean → 该键回落默认 + 警告 |
| `maxImages` | 整数 ≥ 1 | `10` | 非法 → 回落默认 + 警告 |
| `maxImageBytes` | 整数 ≥ 0（字节） | `25165824`（24 MiB） | `0` = 关闭体积规则；非法 → 回落默认 + 警告 |
| `dumpDir` | string | `~/.pi/agent/image-prune` | `~` 展开为 home；相对路径按 home 解析 |
| `retentionDays` | 整数 ≥ 0 | `7` | `0` = 不清理；非法 → 回落默认 + 警告 |

未知键忽略。非法 JSON → 全部默认 + 一次警告。逐键回落：某个键非法只影响它自己。

### 环境变量

| 变量 | 语义 |
| --- | --- |
| `PI_IMAGE_PRUNE` | `off`/`0`/`false`/`no` → 关闭剪枝；`on`/`1`/`true`/`yes` → 打开；其它值 → 警告并忽略 |
| `PI_IMAGE_PRUNE_MAX` | 覆盖 `maxImages`（须为 ≥ 1 的整数） |
| `PI_IMAGE_PRUNE_MAX_BYTES` | 覆盖 `maxImageBytes`（须为 ≥ 0 的整数；`0` 合法 = 关闭体积规则） |
| `PI_IMAGE_PRUNE_DUMP_DIR` | 覆盖 `dumpDir` |

配置在扩展加载时读一次，并在每次 `session_start` 重读（改配置后新开会话即生效）。

**关闭时**（`enabled: false` 或 `PI_IMAGE_PRUNE=off`）：不剪枝、不落盘、不写 `prune.log`、不清理过期目录；但仍保留只读的兜底计数与警告，以便发现「图片数已超限」。

> 刻意**不写** pi 的 `settings.json`：该文件有 schema 校验，塞自定义键有被拒风险；独立配置文件最稳。

## 落盘

- 路径：`<dumpDir>/YYYY-MM-DD/<sha256(base64)[:12]>.<ext>`
  - `ext` 由 `mimeType` 映射：`image/png→png`、`image/jpeg→jpg`、`image/webp→webp`、`image/gif→gif`、`image/bmp→bmp`；其它/缺失 → `bin`
  - 日期取**本地时区**当天
- **内容寻址**：同一张图只落一份（进程内 `Set` + `existsSync` 双查）
- **原子写**：先写 `.tmp-<pid>-<rand>`，`fsync` 后 `rename`；失败清理临时文件
- **权限**：目录 `0700`、文件 `0600`（截图可能含敏感信息）
- **保留**：`session_start` 时 best-effort 删除 mtime 早于 `retentionDays` 的日期目录；全程 try/catch，失败只记警告
- **日志**：每次实际剪枝（`pruned.length > 0`）时向 `<dumpDir>/prune.log` 追加一行 JSONL：

```json
{"ts":"2026-09-27T12:00:00.000Z","sessionId":"01a0...","maxImages":10,"maxImageBytes":25165824,
 "totalImages":12,"totalBytes":57307770,"keptBytes":8788419,
 "pruned":[{"hash":"a1b2c3d4e5f6","path":"/abs/path.png","reason":"count"},
           {"hash":"...","path":null,"error":"EACCES","reason":"bytes"}]}
```

`reason` 为该张因哪条规则被剪：`count` = 张数上限；`bytes` = 体积预算。

### 占位文字（逐字固定）

```text
[早期图片已省略 · 超出单次请求上限 10 张 · 原图: /abs/path.png]
[早期图片已省略 · 超出单次请求上限 10 张 · 落盘失败: EACCES]
[早期图片已省略 · 超出单次请求体积预算 24 MiB · 原图: /abs/path.png]
[早期图片已省略 · 超出单次请求体积预算 24 MiB · 落盘失败: EACCES]
```

## `/image-prune` 命令

| 命令 | 行为 |
| --- | --- |
| `/image-prune` | 显示生效配置（每键标注来源 `env`/`file`/`session`/`default`）+ 本会话统计（请求数、已剪张数、落盘个数、最近一次请求图片总数） |
| `/image-prune max <n>` | 本会话内临时改张数上限（内存，不写文件），回显新值 |
| `/image-prune bytes <n>[MiB]` | 本会话内临时改体积预算：`n` 为纯字节数或 `<n>MiB`（不区分大小写）；`0` = 关闭体积规则 |
| `/image-prune on` / `off` | 本会话内临时开关 |

非法参数 → 回显用法，不抛异常。

## 已知限制

1. **system prompt 里的图片不覆盖**：`context` 事件看不到 system 消息。pi 目前不往 system 塞图；由 `before_provider_request` 的只读兜底计数负责报警。
2. **handler 顺序**：若其它扩展在本扩展的 handler **之后**才往 messages 里塞图，本次计数不到 —— 同样由兜底计数报警（不改行为）。
3. **prompt cache**：首次剪枝与「又多挤出一张」时会失效该处之后的前缀；属预期代价。
4. **磁盘占用**：按 `retentionDays` 清理；长期关闭清理需自行留意。
5. **单条消息内超限**时无法保留全部新图：全局规则下该条自然只保留最后 `maxImages` 张，其余靠落盘路径找回。
6. **单张图自身超预算只提示不处理**：`keptCount === 1` 且该张仍 > 预算时发一次提示，但不剪掉它（宁可超预算也不把请求剪空）。特例：若整个请求只有这一张图，因无剪枝发生，连提示也不会发。
7. **文本与工具输出的体积不计入**：`maxImageBytes` 只算图片块。
8. **file_id 类图片不覆盖**：pi 不使用 Files API 的 `file_id`，本扩展也不处理。
9. **体积是估算**：公式为 base64 长度 × 3/4，不含 JSON 结构开销（引号/字段名/转义）。默认 24 MiB 是 48 MiB 请求体上限的一半，留了一半余量。
10. **估算基于 pi 归一化之后的图片**：pi 在 `context` 之前会缩放/重编码图片（实测 11.45 MiB 的 2000×2000 PNG 到 `context` 时每张 ≈2.2 MiB），所以预算实际约束的是归一化后的 base64 体积。
11. **provider 侧其它限制**不覆盖（如上游路由的临时差异；单张体积已由 pi 的 `resize` + `maxBytes` 管）。
12. 落盘图片可能含敏感内容 —— 目录/文件权限已收紧，且默认 7 天清理。

### 实测说明（前提复核）

真实失败归因已由 provider 报错原文确定（见上文「为什么需要」）：上限随上游路由变（实测 20/30），而非固定 10。

本仓库实现期间另有一组实测：**12 张 8×8 的极小图（各 ~220B）在不加载本扩展时也能成功**；但 12 张 256×256（各 ~197KB，共 2.4MB）与 12 张 768×768（各 ~1.77MB，共 21MB）在不加载扩展时**请求挂起（300s 超时，exit=124）**，加载扩展并设 `maxImages=3` 后**同样 12 张图成功返回（exit=0）**。即：失败与图片**数量 + 体积**共同相关，而非单纯的数量硬上限；这也是同时保留张数规则与体积预算的原因。

体积预算端到端冒烟（`PI_IMAGE_PRUNE_MAX=10 PI_IMAGE_PRUNE_MAX_BYTES=20971520`，10 张 11.45 MiB PNG）：请求成功，`prune.log` 末行 `totalBytes=22550562`、`keptBytes=20295507`、存在 `reason: "bytes"` 条目。注意 pi 在 `context` 之前会归一化图片（11.45 MiB → ≈2.2 MiB/张），所以需 10 张才能触发 20 MiB 预算；且高熵噪声图经重编码后仍很大，会让 provider 挂起（与本扩展无关），冒烟应用「文件大、内容平滑」的 PNG。

## 卸载

```bash
pi remove pi-image-prune
```

或手动从 `~/.pi/agent/settings.json` 的 `packages` 列表里移除该条目（本扩展是本地路径引用，不会拷贝文件）。配置文件与落盘目录需自行清理：

```bash
rm -f ~/.pi/agent/image-prune.json
rm -rf ~/.pi/agent/image-prune
```

## 安装

```bash
pi install /home/chaozi/桌面/learn/manager/asset/pi-image-prune
```

本地路径按引用加载，不拷贝。装入后 manager 与所有子 agent 都会生效。

> **本项目不会被写入 manager 仓库的 `.pi/settings.json`**：安装是用户级全局行为（写 `~/.pi/agent/settings.json`），保持项目配置干净。

## 开发

零运行时依赖、零必需 devDependency；`node ≥ 22.18` 原生直跑 TypeScript，无需编译、无需 `npm install`。

```bash
node --test tests/*.test.ts
```

代码分层：`lib/{config,scan,prune}.ts` 是纯函数（不碰 fs、不 import pi）；`lib/dump.ts` 是唯一 I/O 模块；`extensions/index.ts` 只做事件接线。
