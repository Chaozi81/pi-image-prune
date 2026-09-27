# pi-image-prune

pi 扩展：**请求级图片剪枝** —— 单次请求里的图片数超过可配置上限（默认 10）时，自动把**最旧的**图片落盘到本地并以带绝对路径的占位文字替换，让请求能正常发出。

## 为什么需要

模型经 opencode.ai zen 调用时，**单次请求里的图片过多（超过 10 张）会导致对话无法正常完成**（本机实测表现为请求长时间无响应，见下文「实测说明」）。

pi 的模型配置 schema 里**已有** `inputLimits.images.maxPerRequest`，但 pi 0.87.1 的实现里只用到 `resize`，**没有任何地方强制数量上限**（本机 `deepseek-v4.1-flash` 的 `inputLimits` 只有 `resize`）。会话一旦攒够超限的图片，之后每一轮请求都会带着这些图 → 每一轮都失败，会话实际上被卡死。

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
  "dumpDir": "~/.pi/agent/image-prune",
  "retentionDays": 7
}
```

| 键 | 类型 / 取值 | 默认 | 校验 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 非 boolean → 该键回落默认 + 警告 |
| `maxImages` | 整数 ≥ 1 | `10` | 非法 → 回落默认 + 警告 |
| `dumpDir` | string | `~/.pi/agent/image-prune` | `~` 展开为 home；相对路径按 home 解析 |
| `retentionDays` | 整数 ≥ 0 | `7` | `0` = 不清理；非法 → 回落默认 + 警告 |

未知键忽略。非法 JSON → 全部默认 + 一次警告。逐键回落：某个键非法只影响它自己。

### 环境变量

| 变量 | 语义 |
| --- | --- |
| `PI_IMAGE_PRUNE` | `off`/`0`/`false`/`no` → 关闭剪枝；`on`/`1`/`true`/`yes` → 打开；其它值 → 警告并忽略 |
| `PI_IMAGE_PRUNE_MAX` | 覆盖 `maxImages`（须为 ≥ 1 的整数） |
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
- **日志**：每次实际剪枝时向 `<dumpDir>/prune.log` 追加一行 JSONL：

```json
{"ts":"2026-09-27T12:00:00.000Z","sessionId":"01a0...","maxImages":10,"totalImages":12,
 "pruned":[{"hash":"a1b2c3d4e5f6","path":"/abs/path.png"},{"hash":"...","path":null,"error":"EACCES"}]}
```

### 占位文字（逐字固定）

```text
[早期图片已省略 · 超出单次请求上限 10 张 · 原图: /abs/path.png]
[早期图片已省略 · 超出单次请求上限 10 张 · 落盘失败: EACCES]
```

## `/image-prune` 命令

| 命令 | 行为 |
| --- | --- |
| `/image-prune` | 显示生效配置（每键标注来源 `env`/`file`/`session`/`default`）+ 本会话统计（请求数、已剪张数、落盘个数、最近一次请求图片总数） |
| `/image-prune max <n>` | 本会话内临时改上限（内存，不写文件），回显新值 |
| `/image-prune on` / `off` | 本会话内临时开关 |

非法参数 → 回显用法，不抛异常。

## 已知限制

1. **system prompt 里的图片不覆盖**：`context` 事件看不到 system 消息。pi 目前不往 system 塞图；由 `before_provider_request` 的只读兜底计数负责报警。
2. **handler 顺序**：若其它扩展在本扩展的 handler **之后**才往 messages 里塞图，本次计数不到 —— 同样由兜底计数报警（不改行为）。
3. **prompt cache**：首次剪枝与「又多挤出一张」时会失效该处之后的前缀；属预期代价。
4. **磁盘占用**：按 `retentionDays` 清理；长期关闭清理需自行留意。
5. **单条消息内超限**时无法保留全部新图：该条只保留最后 `maxImages` 张，其余靠落盘路径找回。
6. **多条消息各自超限**时，剪枝后总数仍可能 > `maxImages`（每条消息受「只保留最后 N 张」约束），此时由兜底计数报警。
7. **provider 侧其它限制**不覆盖（单张体积已由 pi 的 `resize` + `maxBytes` 管）。
8. 落盘图片可能含敏感内容 —— 目录/文件权限已收紧，且默认 7 天清理。

### 实测说明（前提复核）

设计文档的前提是「单次请求图片超过 10 张即失败」。本仓库实现期间实测：**12 张 8×8 的极小图（各 ~220B）在不加载本扩展时也能成功**；但 12 张 256×256（各 ~197KB，共 2.4MB）与 12 张 768×768（各 ~1.77MB，共 21MB）在不加载扩展时**请求挂起（300s 超时，exit=124）**，加载扩展并设 `maxImages=3` 后**同样 12 张图成功返回（exit=0）**。即：失败与图片**数量 + 体积**共同相关，而非单纯的数量硬上限；本扩展对「真实截图体积 + 图片过多」的场景有效。

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
