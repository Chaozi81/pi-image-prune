import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveConfig, type ResolvedConfig } from "../lib/config.ts";
import { createDumper, type Dumper } from "../lib/dump.ts";
import { pruneImages } from "../lib/prune.ts";

type NotifyType = "info" | "warning" | "error";

interface Stats {
  /** context handler 被调用的次数 */
  requests: number;
  /** 本会话累计剪掉的图片数 */
  prunedCount: number;
  /** 本会话累计成功落盘的图片数 */
  dumpedCount: number;
  /** 最近一次实际剪枝时的图片总数 */
  lastTotalImages: number | null;
}

type ConfigKey = "enabled" | "maxImages" | "dumpDir" | "retentionDays";

/** 统计 payload 里 {type:"image"} 的个数(只读; 有环/超深保护) */
function countImages(payload: unknown): number {
  let count = 0;
  let nodes = 0;
  const seen = new Set<unknown>();
  const walk = (v: unknown, depth: number): void => {
    if (depth > 30 || nodes > 200_000) return;
    if (!v || typeof v !== "object") return;
    if (seen.has(v)) return;
    seen.add(v);
    nodes++;
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1);
      return;
    }
    const obj = v as Record<string, unknown>;
    if (obj.type === "image") count++;
    for (const key of Object.keys(obj)) walk(obj[key], depth + 1);
  };
  walk(payload, 0);
  return count;
}

export default function imagePrune(pi: ExtensionAPI): void {
  let cfg: ResolvedConfig = resolveConfig();
  let dumper: Dumper = createDumper({ dumpDir: cfg.dumpDir });
  let notified = new Set<string>();
  let sessionOverrides = new Set<ConfigKey>();
  let stats: Stats = { requests: 0, prunedCount: 0, dumpedCount: 0, lastTotalImages: null };

  function notifyOnce(
    ctx: ExtensionContext,
    key: string,
    message: string,
    type: NotifyType = "info"
  ): void {
    if (notified.has(key)) return;
    notified.add(key);
    try {
      ctx.ui.notify(message, type);
    } catch {
      // UI 不可用时静默
    }
  }

  function sessionId(ctx: ExtensionContext): string | undefined {
    try {
      return ctx.sessionManager.getSessionId();
    } catch {
      return undefined;
    }
  }

  function sourceOf(key: ConfigKey): string {
    return sessionOverrides.has(key) ? "session" : cfg.sources[key];
  }

  function formatStatus(): string {
    const lines = [
      "image-prune 生效配置 (值 / 来源):",
      `  enabled       = ${cfg.enabled}  (${sourceOf("enabled")})`,
      `  maxImages     = ${cfg.maxImages}  (${sourceOf("maxImages")})`,
      `  dumpDir       = ${cfg.dumpDir}  (${sourceOf("dumpDir")})`,
      `  retentionDays = ${cfg.retentionDays}  (${sourceOf("retentionDays")})`,
      "本会话统计:",
      `  requests      = ${stats.requests}`,
      `  pruned        = ${stats.prunedCount}`,
      `  dumped        = ${stats.dumpedCount}`,
      `  lastTotalImages = ${stats.lastTotalImages ?? "-"}`,
      "用法: /image-prune [max <n> | on | off]",
    ];
    return lines.join("\n");
  }

  // ---- session_start: 重读配置、重建 dumper、清空会话态、best-effort 清理 ----
  pi.on("session_start", (_event, ctx) => {
    try {
      cfg = resolveConfig();
      dumper = createDumper({ dumpDir: cfg.dumpDir });
      notified = new Set<string>();
      sessionOverrides = new Set<ConfigKey>();
      stats = { requests: 0, prunedCount: 0, dumpedCount: 0, lastTotalImages: null };
      if (cfg.warnings.length > 0) {
        notifyOnce(ctx, "config-warnings", `image-prune 配置警告: ${cfg.warnings.join("; ")}`, "warning");
      }
      try {
        dumper.pruneOld(cfg.retentionDays);
      } catch {
        // best-effort: 清理失败不影响启动
      }
    } catch {
      // 重读失败保持现状
    }
  });

  // ---- context: 请求级剪枝(唯一修改请求内容的挂载点) ----
  pi.on("context", (event, ctx) => {
    // 关闭语义: 不剪枝/不落盘/不写日志/不清理(兜底计数仍在 before_provider_request 保留)
    if (!cfg.enabled) return;
    try {
      stats.requests++;
      const res = pruneImages(event.messages, {
        maxImages: cfg.maxImages,
        dump: (img) => dumper.dump(img),
      });
      if (!res) return;

      stats.prunedCount += res.pruned.length;
      for (const p of res.pruned) {
        if (p.path !== null) stats.dumpedCount++;
      }
      stats.lastTotalImages = res.totalImages;

      const logged = dumper.log({
        ts: new Date().toISOString(),
        sessionId: sessionId(ctx),
        maxImages: cfg.maxImages,
        totalImages: res.totalImages,
        pruned: res.pruned.map((p) =>
          p.path !== null
            ? { hash: p.hash, path: p.path }
            : { hash: p.hash, path: null, error: p.error }
        ),
      });
      if (!logged) {
        notifyOnce(ctx, "log-failed", "image-prune: 写 prune.log 失败(剪枝结果不受影响)", "warning");
      }

      // (a) 首次剪枝
      notifyOnce(
        ctx,
        "first-prune",
        `image-prune: 本次请求 ${res.totalImages} 张图, 超出上限 ${cfg.maxImages}, 已把最旧的 ${res.pruned.length} 张落盘并替换为占位文字`,
        "info"
      );
      // (b) 单条消息自身超限
      if (res.overLimitInSingleMessage) {
        notifyOnce(
          ctx,
          "single-message-over",
          `image-prune: 有单条消息自身图片数超过上限 ${cfg.maxImages}, 该条只保留最后 ${cfg.maxImages} 张`,
          "warning"
        );
      }
      // (d) 落盘失败
      const failed = res.pruned.filter((p) => p.path === null);
      if (failed.length > 0) {
        notifyOnce(
          ctx,
          "dump-failed",
          `image-prune: ${failed.length} 张图片落盘失败(例: ${failed[0].error}), 占位文字已标注`,
          "warning"
        );
      }

      return { messages: res.messages };
    } catch (err) {
      // fail-open: 内部故障一律放行原消息
      notifyOnce(
        ctx,
        "handler-error",
        `image-prune 内部错误, 已原样放行本次请求: ${err instanceof Error ? err.message : String(err)}`,
        "warning"
      );
      return;
    }
  });

  // ---- before_provider_request: 只读兜底计数(不修改 payload) ----
  pi.on("before_provider_request", (event, ctx) => {
    try {
      const n = countImages(event.payload);
      if (n > cfg.maxImages) {
        // (c) 兜底计数发现超限
        notifyOnce(
          ctx,
          "payload-over",
          `image-prune: 最终请求里仍有 ${n} 张图超过上限 ${cfg.maxImages}, 可能来自其它扩展或 system prompt, 请报告`,
          "warning"
        );
      }
    } catch {
      // 只读兜底: 任何失败都静默
    }
    // 不 return 任何值 → 不改动 payload
  });

  // ---- /image-prune 命令 ----
  pi.registerCommand("image-prune", {
    description: "图片剪枝: 查看生效配置与统计 / max <n> / on / off",
    handler: async (args, ctx) => {
      try {
        const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
        if (parts.length === 0) {
          ctx.ui.notify(formatStatus(), "info");
          return;
        }
        const sub = parts[0].toLowerCase();
        if (sub === "on" || sub === "off") {
          cfg = { ...cfg, enabled: sub === "on" };
          sessionOverrides.add("enabled");
          ctx.ui.notify(`image-prune: 本会话已${sub === "on" ? "开启" : "关闭"}`, "info");
          return;
        }
        if (sub === "max") {
          const raw = parts[1];
          const n = raw === undefined ? Number.NaN : Number(raw);
          if (!Number.isInteger(n) || n < 1) {
            ctx.ui.notify("用法: /image-prune max <n>  (n 为 >=1 的整数)", "error");
            return;
          }
          cfg = { ...cfg, maxImages: n };
          sessionOverrides.add("maxImages");
          ctx.ui.notify(`image-prune: 本会话上限已设为 ${n}`, "info");
          return;
        }
        ctx.ui.notify(
          "用法: /image-prune | /image-prune max <n> | /image-prune on | /image-prune off",
          "error"
        );
      } catch (err) {
        try {
          ctx.ui.notify(
            `image-prune 命令错误: ${err instanceof Error ? err.message : String(err)}`,
            "error"
          );
        } catch {
          // ignore
        }
      }
    },
  });
}
