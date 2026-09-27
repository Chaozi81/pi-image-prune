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
