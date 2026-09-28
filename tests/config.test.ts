import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveConfig, DEFAULTS } from "../lib/config.ts";

const HOME = "/home/testuser";

const missing = (): never => {
  const e = new Error("ENOENT: no such file") as NodeJS.ErrnoException;
  e.code = "ENOENT";
  throw e;
};

const fileWith = (obj: unknown) => () => JSON.stringify(obj);
const rawFile = (s: string) => () => s;

test("无文件无 env → 全默认 + sources 全 default", () => {
  const cfg = resolveConfig({ env: {}, home: HOME, readFile: missing });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.maxImages, 10);
  assert.equal(cfg.maxImageBytes, 25165824);
  assert.equal(cfg.dumpDir, `${HOME}/.pi/agent/image-prune`);
  assert.equal(cfg.retentionDays, 7);
  assert.deepEqual(cfg.sources, {
    enabled: "default",
    maxImages: "default",
    maxImageBytes: "default",
    dumpDir: "default",
    retentionDays: "default",
  });
  assert.equal(cfg.warnings.length, 0);
});

test("文件五键生效", () => {
  const cfg = resolveConfig({
    env: {},
    home: HOME,
    readFile: fileWith({
      enabled: false,
      maxImages: 5,
      maxImageBytes: 8388608,
      dumpDir: "~/dumps",
      retentionDays: 3,
    }),
  });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.maxImages, 5);
  assert.equal(cfg.maxImageBytes, 8388608);
  assert.equal(cfg.dumpDir, `${HOME}/dumps`);
  assert.equal(cfg.retentionDays, 3);
  assert.deepEqual(cfg.sources, {
    enabled: "file",
    maxImages: "file",
    maxImageBytes: "file",
    dumpDir: "file",
    retentionDays: "file",
  });
  assert.equal(cfg.warnings.length, 0);
});

test("env 覆盖 file", () => {
  const cfg = resolveConfig({
    env: { PI_IMAGE_PRUNE_MAX: "3", PI_IMAGE_PRUNE_DUMP_DIR: "/tmp/xyz" },
    home: HOME,
    readFile: fileWith({ maxImages: 5, dumpDir: "~/dumps", retentionDays: 3 }),
  });
  assert.equal(cfg.maxImages, 3);
  assert.equal(cfg.dumpDir, "/tmp/xyz");
  assert.equal(cfg.sources.maxImages, "env");
  assert.equal(cfg.sources.dumpDir, "env");
  // 未被 env 覆盖的键仍来自 file
  assert.equal(cfg.retentionDays, 3);
  assert.equal(cfg.sources.retentionDays, "file");
});

test("PI_IMAGE_PRUNE=off → enabled:false, 来源 env", () => {
  const cfg = resolveConfig({
    env: { PI_IMAGE_PRUNE: "off" },
    home: HOME,
    readFile: missing,
  });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.sources.enabled, "env");
});

test("PI_IMAGE_PRUNE=on → enabled:true, 来源 env", () => {
  const cfg = resolveConfig({
    env: { PI_IMAGE_PRUNE: "on" },
    home: HOME,
    readFile: fileWith({ enabled: false }),
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.sources.enabled, "env");
});

test("PI_IMAGE_PRUNE=maybe → 回落默认 + warning", () => {
  const cfg = resolveConfig({
    env: { PI_IMAGE_PRUNE: "maybe" },
    home: HOME,
    readFile: missing,
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.sources.enabled, "default");
  assert.ok(cfg.warnings.length >= 1);
});

test("maxImages 非法值(0/-1/1.5/\"10\") → 回落默认 + warning", () => {
  for (const bad of [0, -1, 1.5, "10"]) {
    const cfg = resolveConfig({
      env: {},
      home: HOME,
      readFile: fileWith({ maxImages: bad }),
    });
    assert.equal(cfg.maxImages, DEFAULTS.maxImages, `bad=${JSON.stringify(bad)}`);
    assert.equal(cfg.sources.maxImages, "default", `bad=${JSON.stringify(bad)}`);
    assert.ok(cfg.warnings.length >= 1, `bad=${JSON.stringify(bad)}`);
  }
});

test("retentionDays 非法值(-1/1.5/\"7\") → 回落默认 + warning", () => {
  for (const bad of [-1, 1.5, "7"]) {
    const cfg = resolveConfig({
      env: {},
      home: HOME,
      readFile: fileWith({ retentionDays: bad }),
    });
    assert.equal(cfg.retentionDays, DEFAULTS.retentionDays, `bad=${JSON.stringify(bad)}`);
    assert.equal(cfg.sources.retentionDays, "default", `bad=${JSON.stringify(bad)}`);
    assert.ok(cfg.warnings.length >= 1, `bad=${JSON.stringify(bad)}`);
  }
});

test("retentionDays 0 合法(不清理)", () => {
  const cfg = resolveConfig({
    env: {},
    home: HOME,
    readFile: fileWith({ retentionDays: 0 }),
  });
  assert.equal(cfg.retentionDays, 0);
  assert.equal(cfg.sources.retentionDays, "file");
  assert.equal(cfg.warnings.length, 0);
});

test("enabled 非 boolean → 回落默认 + warning", () => {
  const cfg = resolveConfig({
    env: {},
    home: HOME,
    readFile: fileWith({ enabled: "yes" }),
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.sources.enabled, "default");
  assert.ok(cfg.warnings.length >= 1);
});

test("非法 JSON → 全默认 + 1 条 warning", () => {
  const cfg = resolveConfig({ env: {}, home: HOME, readFile: rawFile("{not json") });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.maxImages, 10);
  assert.equal(cfg.dumpDir, `${HOME}/.pi/agent/image-prune`);
  assert.equal(cfg.retentionDays, 7);
  assert.deepEqual(cfg.sources, {
    enabled: "default",
    maxImages: "default",
    maxImageBytes: "default",
    dumpDir: "default",
    retentionDays: "default",
  });
  assert.equal(cfg.warnings.length, 1);
});

test("maxImageBytes: env 覆盖 file", () => {
  const cfg = resolveConfig({
    env: { PI_IMAGE_PRUNE_MAX_BYTES: "1048576" },
    home: HOME,
    readFile: fileWith({ maxImageBytes: 8388608 }),
  });
  assert.equal(cfg.maxImageBytes, 1048576);
  assert.equal(cfg.sources.maxImageBytes, "env");
});

test("maxImageBytes 文件非法(-1/1.5/\"x\") → 回落默认 + warning", () => {
  for (const bad of [-1, 1.5, "x"]) {
    const cfg = resolveConfig({
      env: {},
      home: HOME,
      readFile: fileWith({ maxImageBytes: bad }),
    });
    assert.equal(cfg.maxImageBytes, DEFAULTS.maxImageBytes, `bad=${JSON.stringify(bad)}`);
    assert.equal(cfg.sources.maxImageBytes, "default", `bad=${JSON.stringify(bad)}`);
    assert.ok(cfg.warnings.length >= 1, `bad=${JSON.stringify(bad)}`);
  }
});

test("maxImageBytes 0 合法(关闭体积规则)", () => {
  const cfg = resolveConfig({
    env: {},
    home: HOME,
    readFile: fileWith({ maxImageBytes: 0 }),
  });
  assert.equal(cfg.maxImageBytes, 0);
  assert.equal(cfg.sources.maxImageBytes, "file");
  assert.equal(cfg.warnings.length, 0);
});

test("PI_IMAGE_PRUNE_MAX_BYTES 非法(abc/-1/1.5/空串外) → 忽略 + warning", () => {
  for (const bad of ["abc", "-1", "1.5", "1MiB"]) {
    const cfg = resolveConfig({
      env: { PI_IMAGE_PRUNE_MAX_BYTES: bad },
      home: HOME,
      readFile: missing,
    });
    assert.equal(cfg.maxImageBytes, DEFAULTS.maxImageBytes, `bad=${bad}`);
    assert.equal(cfg.sources.maxImageBytes, "default", `bad=${bad}`);
    assert.ok(cfg.warnings.length >= 1, `bad=${bad}`);
  }
});

test("PI_IMAGE_PRUNE_MAX_BYTES=0 合法(env 来源)", () => {
  const cfg = resolveConfig({
    env: { PI_IMAGE_PRUNE_MAX_BYTES: "0" },
    home: HOME,
    readFile: missing,
  });
  assert.equal(cfg.maxImageBytes, 0);
  assert.equal(cfg.sources.maxImageBytes, "env");
  assert.equal(cfg.warnings.length, 0);
});

test("dumpDir 的 ~ 展开", () => {
  const cfg = resolveConfig({
    env: {},
    home: HOME,
    readFile: fileWith({ dumpDir: "~/x" }),
  });
  assert.equal(cfg.dumpDir, `${HOME}/x`);
});

test("dumpDir 相对路径按 home 解析", () => {
  const cfg = resolveConfig({
    env: {},
    home: HOME,
    readFile: fileWith({ dumpDir: "rel" }),
  });
  assert.equal(cfg.dumpDir, `${HOME}/rel`);
});

test("dumpDir 绝对路径原样保留", () => {
  const cfg = resolveConfig({
    env: {},
    home: HOME,
    readFile: fileWith({ dumpDir: "/var/dumps" }),
  });
  assert.equal(cfg.dumpDir, "/var/dumps");
});

test("PI_IMAGE_PRUNE_MAX 非法(0/abc/-1) → 忽略 + warning", () => {
  for (const bad of ["0", "abc", "-1", "1.5"]) {
    const cfg = resolveConfig({
      env: { PI_IMAGE_PRUNE_MAX: bad },
      home: HOME,
      readFile: missing,
    });
    assert.equal(cfg.maxImages, DEFAULTS.maxImages, `bad=${bad}`);
    assert.equal(cfg.sources.maxImages, "default", `bad=${bad}`);
    assert.ok(cfg.warnings.length >= 1, `bad=${bad}`);
  }
});

test("未知键忽略且不产生 warning", () => {
  const cfg = resolveConfig({
    env: {},
    home: HOME,
    readFile: fileWith({ unknownKey: 1, another: "x", maxImages: 8 }),
  });
  assert.equal(cfg.maxImages, 8);
  assert.equal(cfg.warnings.length, 0);
});

test("自定义 configPath 生效", () => {
  const seen: string[] = [];
  const cfg = resolveConfig({
    env: {},
    home: HOME,
    configPath: "/etc/ip.json",
    readFile: (p) => {
      seen.push(p);
      return JSON.stringify({ maxImages: 4 });
    },
  });
  assert.deepEqual(seen, ["/etc/ip.json"]);
  assert.equal(cfg.maxImages, 4);
});
