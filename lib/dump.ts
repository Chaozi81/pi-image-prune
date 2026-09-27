import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** 内容寻址哈希: base64 原文 → sha256 十六进制前 12 位 */
export function hashImage(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex").slice(0, 12);
}

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
};

export function extForMime(mimeType: string | undefined): string {
  return (mimeType && EXT_BY_MIME[mimeType]) || "bin";
}

/** <dumpDir>/YYYY-MM-DD/<hash>.<ext>; 日期取本地时区 */
export function dumpPath(
  dumpDir: string,
  hash: string,
  mimeType: string | undefined,
  now = new Date()
): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${dumpDir}/${y}-${m}-${d}/${hash}.${extForMime(mimeType)}`;
}

export interface Dumper {
  /** 写盘(内容寻址去重); 返回绝对路径或错误 */
  dump(img: { hash: string; data: string; mimeType?: string }): { path: string } | { error: string };
  /** best-effort 删除 mtime 早于 retentionDays 的日期目录; 0 = 不清理 */
  pruneOld(retentionDays: number): { removed: string[]; errors: string[] };
  /** 追加一行 JSONL 到 <dumpDir>/prune.log; 失败静默返回 false */
  log(line: Record<string, unknown>): boolean;
}

export function createDumper(opts: { dumpDir: string; now?: () => Date }): Dumper {
  const { dumpDir, now = () => new Date() } = opts;
  const seen = new Set<string>();

  return {
    dump(img): { path: string } | { error: string } {
      const target = dumpPath(dumpDir, img.hash, img.mimeType, now());
      if (seen.has(img.hash) || existsSync(target)) {
        seen.add(img.hash);
        return { path: target };
      }
      try {
        const dir = join(dumpDir, target.split("/").slice(-2, -1)[0]);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const tmp = join(dir, `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
        writeFileSync(tmp, img.data, { mode: 0o600 });
        const fd = fsyncSync ? undefined : undefined; // fsyncSync 是同步的，不需要 fd
        // 直接用 renameSync，不需要显式 fsync（writeFileSync 已经刷盘）
        renameSync(tmp, target);
        if (existsSync(target)) {
          chmodSync(target, 0o600);
        }
        seen.add(img.hash);
        return { path: target };
      } catch (err) {
        // 清理临时文件
        try {
          const dir = join(dumpDir, target.split("/").slice(-2, -1)[0]);
          const tmpCandidates = readdirSync(dir).filter((f) => f.startsWith(".tmp-"));
          for (const t of tmpCandidates) rmSync(join(dir, t), { force: true });
        } catch {
          // ignore cleanup errors
        }
        return { error: String(err) };
      }
    },

    pruneOld(retentionDays): { removed: string[]; errors: string[] } {
      const removed: string[] = [];
      const errors: string[] = [];
      if (retentionDays <= 0) return { removed, errors };
      const cutoff = now().getTime() - retentionDays * 86400_000;
      try {
        for (const entry of readdirSync(dumpDir)) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(entry)) continue;
          const dirPath = join(dumpDir, entry);
          try {
            const st = statSync(dirPath);
            if (!st.isDirectory()) continue;
            if (st.mtimeMs < cutoff) {
              rmSync(dirPath, { recursive: true, force: true });
              removed.push(dirPath);
            }
          } catch (e) {
            errors.push(String(e));
          }
        }
      } catch {
        // dumpDir 可能不存在，忽略
      }
      return { removed, errors };
    },

    log(line): boolean {
      try {
        appendFileSync(join(dumpDir, "prune.log"), JSON.stringify(line) + "\n");
        return true;
      } catch {
        return false;
      }
    },
  };
}
