import { test } from "node:test";
import assert from "node:assert/strict";
import { pruneImages, placeholderText } from "../lib/prune.ts";
import { hashImage } from "../lib/dump.ts";

const img = (data: string, mimeType = "image/png") =>
  ({ type: "image", data, mimeType } as Record<string, unknown>);
const text = (t: string) => ({ type: "text", text: t });
const user = (content: unknown) => ({ role: "user", content });

function fakeDump(calls: string[]) {
  return (i: { hash: string; data: string; mimeType?: string }) => {
    calls.push(i.hash);
    return { path: `/dump/${i.hash}.png` };
  };
}

test("placeholderText 精确格式", () => {
  assert.equal(
    placeholderText(10, "/dump/a.png"),
    "[早期图片已省略 · 超出单次请求上限 10 张 · 原图: /dump/a.png]"
  );
  assert.equal(
    placeholderText(10, null, "EACCES"),
    "[早期图片已省略 · 超出单次请求上限 10 张 · 落盘失败: EACCES]"
  );
});

test("恰好等于上限 → undefined(同一引用)", () => {
  const msgs = [user([img("a"), text("x")])];
  const msgs10 = [user(Array.from({ length: 10 }, (_, i) => img(`i${i}`)))];
  assert.equal(
    pruneImages(msgs, { maxImages: 10, dump: fakeDump([]) }),
    undefined
  );
  assert.equal(
    pruneImages(msgs10, { maxImages: 10, dump: fakeDump([]) }),
    undefined
  );
});

test("超 1 张 → 只剪最旧, 消息数/块数/顺序不变", () => {
  const calls: string[] = [];
  const msgs = [
    user([img("a"), text("t1"), img("b"), img("c")]),
    user([text("t2"), img("d")]),
    user([img("e"), text("t3")]),
  ];
  const res = pruneImages(msgs, { maxImages: 4, dump: fakeDump(calls) });
  assert.ok(res);
  assert.equal(res!.messages.length, 3);
  // msg0: 4 blocks, msg1: 2 blocks, msg2: 2 blocks
  assert.equal((res!.messages[0] as Record<string, unknown[]>).content.length, 4);
  assert.equal((res!.messages[1] as Record<string, unknown[]>).content.length, 2);
  assert.equal((res!.messages[2] as Record<string, unknown[]>).content.length, 2);
  // 顺序检查
  const c0 = (res!.messages[0] as Record<string, unknown[]>).content;
  assert.equal((c0[0] as Record<string, string>).type, "text"); // a pruned
  assert.equal((c0[1] as Record<string, string>).type, "text");
  assert.equal((c0[1] as Record<string, string>).text, "t1");
  assert.equal((c0[2] as Record<string, string>).type, "image"); // b kept
  assert.equal((c0[3] as Record<string, string>).type, "image"); // c kept
  const c1 = (res!.messages[1] as Record<string, unknown[]>).content;
  assert.equal((c1[0] as Record<string, string>).type, "text");
  assert.equal((c1[0] as Record<string, string>).text, "t2");
  assert.equal((c1[1] as Record<string, string>).type, "image"); // d kept
  const c2 = (res!.messages[2] as Record<string, unknown[]>).content;
  assert.equal((c2[0] as Record<string, string>).type, "image"); // e kept
  assert.equal((c2[1] as Record<string, string>).type, "text");
  assert.equal((c2[1] as Record<string, string>).text, "t3");
  // 只有 a 被剪
  assert.equal(res!.pruned.length, 1);
  assert.equal(res!.pruned[0].msgIndex, 0);
  assert.equal(res!.pruned[0].blockIndex, 0);
});

test("跨消息保留最新 N 张", () => {
  const calls: string[] = [];
  const msgs = [
    user([img("old1"), img("old2")]),
    user([img("new1"), img("new2")]),
  ];
  const res = pruneImages(msgs, { maxImages: 2, dump: fakeDump(calls) });
  assert.ok(res);
  const c0 = (res!.messages[0] as Record<string, unknown[]>).content;
  const c1 = (res!.messages[1] as Record<string, unknown[]>).content;
  assert.equal((c0[0] as Record<string, string>).type, "text"); // old1 pruned
  assert.equal((c0[1] as Record<string, string>).type, "text"); // old2 pruned
  assert.equal((c1[0] as Record<string, string>).type, "image"); // new1 kept
  assert.equal((c1[1] as Record<string, string>).type, "image"); // new2 kept
  assert.equal(res!.pruned.length, 2);
});

test("不修改入参(快照对比)", () => {
  const calls: string[] = [];
  const msgs = [
    user([img("a"), text("x"), img("b")]),
    user([text("y")]),
  ];
  const snapshot = structuredClone(msgs);
  pruneImages(msgs, { maxImages: 1, dump: fakeDump(calls) });
  assert.deepEqual(msgs, snapshot);
});

test("未改动的消息按引用复用", () => {
  const calls: string[] = [];
  const msgs = [
    user([img("a"), img("b")]),
    user([text("unchanged")]),
    user([img("c")]),
  ];
  const res = pruneImages(msgs, { maxImages: 2, dump: fakeDump(calls) });
  assert.ok(res);
  // msg0 被改动(剪了 a), msg1 无图不需改, msg2 保留 c 未超限不需改
  assert.notEqual(res!.messages[0], msgs[0]);
  assert.equal(res!.messages[1], msgs[1]);
  assert.equal(res!.messages[2], msgs[2]);
});

test("幂等: 对结果再跑一次 → undefined", () => {
  const calls: string[] = [];
  const msgs = [user([img("a"), img("b"), img("c")])];
  const res = pruneImages(msgs, { maxImages: 2, dump: fakeDump(calls) });
  assert.ok(res);
  const second = pruneImages(res!.messages, { maxImages: 2, dump: fakeDump(calls) });
  assert.equal(second, undefined);
});

test("单条消息内 12 张(上限 10) → 留该条最后 10 张, overLimitInSingleMessage === true", () => {
  const calls: string[] = [];
  const imgs = Array.from({ length: 12 }, (_, i) => img(`i${i}`));
  const msgs = [user(imgs)];
  const res = pruneImages(msgs, { maxImages: 10, dump: fakeDump(calls) });
  assert.ok(res);
  assert.equal(res!.totalImages, 12);
  assert.equal(res!.overLimitInSingleMessage, true);
  assert.equal(res!.pruned.length, 2);
  const content = (res!.messages[0] as Record<string, unknown[]>).content;
  assert.equal(content.length, 12);
  // 前 2 张被剪
  assert.equal((content[0] as Record<string, string>).type, "text");
  assert.equal((content[1] as Record<string, string>).type, "text");
  // 后 10 张保留
  for (let i = 2; i < 12; i++) {
    assert.equal((content[i] as Record<string, string>).type, "image");
  }
});

test("落盘抛错 → 仍剪, 占位含 '落盘失败', pruned[i].path === null 且带 error", () => {
  const dump = () => {
    throw new Error("EACCES");
  };
  const msgs = [user([img("a"), img("b")])];
  const res = pruneImages(msgs, { maxImages: 1, dump });
  assert.ok(res);
  assert.equal(res!.pruned.length, 1);
  assert.equal(res!.pruned[0].path, null);
  assert.equal(res!.pruned[0].error, "EACCES");
  const content = (res!.messages[0] as Record<string, unknown[]>).content;
  assert.ok(
    (content[0] as Record<string, string>).text.includes("落盘失败: EACCES")
  );
});

test("工具结果消息里的图同样被剪", () => {
  const calls: string[] = [];
  const msgs = [
    { role: "tool", content: [img("tool-img"), text("res")] },
    user([img("user-img")]),
  ];
  const res = pruneImages(msgs, { maxImages: 1, dump: fakeDump(calls) });
  assert.ok(res);
  assert.equal(res!.pruned.length, 1);
  assert.equal(res!.pruned[0].msgIndex, 0); // tool msg 的 img 被剪
});

test("content 是字符串的消息原样复用", () => {
  const calls: string[] = [];
  const plain = { role: "user", content: "plain" };
  const msgs = [plain, user([img("a"), img("b")])];
  const res = pruneImages(msgs, { maxImages: 1, dump: fakeDump(calls) });
  assert.ok(res);
  assert.equal(res!.messages[0], plain);
});

test("dump 只对被剪的图调用", () => {
  const calls: string[] = [];
  const msgs = [
    user([img("a")]),
    user([img("b")]),
    user([img("c")]),
    user([img("d")]),
  ];
  pruneImages(msgs, { maxImages: 2, dump: fakeDump(calls) });
  // 总共 4 张, max=2, 剪全局最旧的 2 张: a 和 b
  assert.equal(calls.length, 2);
  assert.ok(calls.includes(hashImage("a")));
  assert.ok(calls.includes(hashImage("b")));
});

test("单条超上限 + 其他消息也超 → 各自保留最后 N 张", () => {
  const calls: string[] = [];
  const msgs = [
    user([img("a"), img("b"), img("c")]), // 3 张, max=2
    user([img("d"), img("e"), img("f")]), // 3 张, max=2
  ];
  const res = pruneImages(msgs, { maxImages: 2, dump: fakeDump(calls) });
  assert.ok(res);
  assert.equal(res!.totalImages, 6);
  assert.equal(res!.overLimitInSingleMessage, true);
  // 每条剪 1 张, 共剪 2 张(但全局 6 张, max=2, 应该剪 4 张...)
  // 等等, 按算法: 每条最多剪 count-max = 1 张
  // 全局 excess = 4, 但每条只能剪 1 张, 总共只能剪 2 张
  // 所以保留 4 张
  assert.equal(res!.pruned.length, 2);
  const c0 = (res!.messages[0] as Record<string, unknown[]>).content;
  const c1 = (res!.messages[1] as Record<string, unknown[]>).content;
  assert.equal((c0[0] as Record<string, string>).type, "text"); // a pruned
  assert.equal((c0[1] as Record<string, string>).type, "image"); // b kept
  assert.equal((c0[2] as Record<string, string>).type, "image"); // c kept
  assert.equal((c1[0] as Record<string, string>).type, "text"); // d pruned
  assert.equal((c1[1] as Record<string, string>).type, "image"); // e kept
  assert.equal((c1[2] as Record<string, string>).type, "image"); // f kept
});
