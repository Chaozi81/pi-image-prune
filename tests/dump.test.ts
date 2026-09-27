import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, readdirSync, writeFileSync, mkdirSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashImage, extForMime, dumpPath, createDumper } from "../lib/dump.ts";

/** 本地日期 YYYY-MM-DD(与 dumpPath 口径一致, 不能用 UTC) */
function localDate(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

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

test("dump 写盘 + 同一内容只写一份", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ip-dump-"));
  const dumper = createDumper({ dumpDir: tmp });
  const r1 = dumper.dump({ hash: hashImage("A"), data: "A", mimeType: "image/png" });
  const r2 = dumper.dump({ hash: hashImage("A"), data: "A", mimeType: "image/png" });
  assert.ok("path" in r1);
  assert.ok("path" in r2);
  assert.equal((r1 as { path: string }).path, (r2 as { path: string }).path);
  const files = readdirSync(join(tmp, localDate()), { recursive: true })
    .filter((f) => typeof f === "string" && !f.startsWith(".")) as string[];
  assert.equal(files.length, 1);
  rmSync(tmp, { recursive: true, force: true });
});

test("dump 文件权限 0600、目录 0700", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ip-dump-"));
  const dumper = createDumper({ dumpDir: tmp });
  const r = dumper.dump({ hash: hashImage("B"), data: "B", mimeType: "image/png" });
  assert.ok("path" in r);
  const dir = join(tmp, localDate());
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync((r as { path: string }).path).mode & 0o777, 0o600);
  rmSync(tmp, { recursive: true, force: true });
});

test("dump 不残留临时文件", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ip-dump-"));
  const dumper = createDumper({ dumpDir: tmp });
  dumper.dump({ hash: hashImage("C"), data: "C", mimeType: "image/png" });
  const dir = join(tmp, localDate());
  const all = readdirSync(dir, { recursive: true }) as string[];
  assert.ok(!all.some((f) => f.startsWith(".tmp-")));
  rmSync(tmp, { recursive: true, force: true });
});

test("dump 目标不可写时返回 error 而不抛", () => {
  const tmp = join(tmpdir(), `ip-dump-block-${Date.now()}`);
  writeFileSync(tmp, "block"); // dumpDir 是一个已存在的普通文件
  const dumper = createDumper({ dumpDir: tmp });
  const r = dumper.dump({ hash: hashImage("D"), data: "D", mimeType: "image/png" });
  assert.ok("error" in r);
  rmSync(tmp, { recursive: true, force: true });
});

test("pruneOld 只删过期日期目录", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ip-dump-"));
  mkdirSync(join(tmp, "2026-09-20"), { recursive: true });
  mkdirSync(join(tmp, "2026-09-26"), { recursive: true });
  // 伪造 mtime: 2026-09-20 目录的 mtime 设为 2026-09-20, 2026-09-26 设为 2026-09-26
  utimesSync(join(tmp, "2026-09-20"), new Date(2026, 8, 20), new Date(2026, 8, 20));
  utimesSync(join(tmp, "2026-09-26"), new Date(2026, 8, 26), new Date(2026, 8, 26));
  const now = new Date(2026, 8, 27); // 2026-09-27
  const dumper = createDumper({ dumpDir: tmp, now: () => now });
  const res = dumper.pruneOld(3);
  assert.deepEqual(res.removed, [join(tmp, "2026-09-20")]);
  assert.equal(res.errors.length, 0);
  assert.throws(() => statSync(join(tmp, "2026-09-20")), /ENOENT/);
  assert.ok(statSync(join(tmp, "2026-09-26")).isDirectory());
  rmSync(tmp, { recursive: true, force: true });
});

test("pruneOld retentionDays=0 什么都不删", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ip-dump-"));
  mkdirSync(join(tmp, "2026-09-20"), { recursive: true });
  const now = new Date(2026, 8, 27);
  const dumper = createDumper({ dumpDir: tmp, now: () => now });
  const res = dumper.pruneOld(0);
  assert.equal(res.removed.length, 0);
  assert.ok(statSync(join(tmp, "2026-09-20")).isDirectory());
  rmSync(tmp, { recursive: true, force: true });
});

test("log 追加 JSONL, 每行可解析", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ip-dump-"));
  const dumper = createDumper({ dumpDir: tmp });
  dumper.log({ a: 1 });
  dumper.log({ b: 2 });
  const logPath = join(tmp, "prune.log");
  const lines = readFileSync(logPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), { a: 1 });
  assert.deepEqual(JSON.parse(lines[1]), { b: 2 });
  rmSync(tmp, { recursive: true, force: true });
});
