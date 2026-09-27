import { test } from "node:test";
import assert from "node:assert/strict";
import { scanImages } from "../lib/scan.ts";

const img = (data: string, mimeType?: string) => ({ type: "image", data, mimeType });
const text = (t: string) => ({ type: "text", text: t });

test("普通 user 消息里的图", () => {
  const msgs = [{ role: "user", content: [img("a", "image/png"), text("hello")] }];
  const refs = scanImages(msgs);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].msgIndex, 0);
  assert.equal(refs[0].blockIndex, 0);
  assert.equal(refs[0].data, "a");
  assert.equal(refs[0].mimeType, "image/png");
});

test("工具结果消息里的图", () => {
  const msgs = [{ role: "tool", content: [img("tool-img", "image/jpeg"), text("result")] }];
  const refs = scanImages(msgs);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].msgIndex, 0);
  assert.equal(refs[0].blockIndex, 0);
  assert.equal(refs[0].data, "tool-img");
  assert.equal(refs[0].mimeType, "image/jpeg");
});

test("一条消息两个图块(索引正确)", () => {
  const msgs = [{ role: "user", content: [img("a"), text("x"), img("b")] }];
  const refs = scanImages(msgs);
  assert.equal(refs.length, 2);
  assert.equal(refs[0].blockIndex, 0);
  assert.equal(refs[1].blockIndex, 2);
});

test("content 是字符串 → 跳过", () => {
  const msgs = [{ role: "user", content: "plain text" }];
  assert.equal(scanImages(msgs).length, 0);
});

test("content 是 undefined → 跳过", () => {
  const msgs = [{ role: "user" }];
  assert.equal(scanImages(msgs).length, 0);
});

test("空数组 → 空结果", () => {
  assert.equal(scanImages([]).length, 0);
});

test("非图片块(text/thinking/tool_call)不误判", () => {
  const msgs = [
    {
      role: "user",
      content: [
        text("hello"),
        { type: "thinking", text: "..." },
        { type: "tool_call", toolCall: {} },
      ],
    },
  ];
  assert.equal(scanImages(msgs).length, 0);
});

test("缺 data 的 image 块仍被计入, data 按空串", () => {
  const msgs = [{ role: "user", content: [{ type: "image" }] }];
  const refs = scanImages(msgs);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].data, "");
  assert.equal(refs[0].msgIndex, 0);
  assert.equal(refs[0].blockIndex, 0);
});

test("跨消息顺序一致", () => {
  const msgs = [
    { role: "user", content: [img("a")] },
    { role: "assistant", content: [text("ok")] },
    { role: "user", content: [img("b"), img("c")] },
  ];
  const refs = scanImages(msgs);
  assert.equal(refs.length, 3);
  assert.deepEqual(
    refs.map((r) => ({ i: r.msgIndex, bi: r.blockIndex, d: r.data })),
    [
      { i: 0, bi: 0, d: "a" },
      { i: 2, bi: 0, d: "b" },
      { i: 2, bi: 1, d: "c" },
    ]
  );
});
