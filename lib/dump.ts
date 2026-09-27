import { createHash } from "node:crypto";

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
