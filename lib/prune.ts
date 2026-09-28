import { scanImages } from "./scan.ts";
import { hashImage } from "./dump.ts";

/** 该张图片因哪条规则被剪: count = 张数上限; bytes = 体积预算 */
export type PruneReason = "count" | "bytes";

export interface PrunedImage {
  hash: string;
  msgIndex: number;
  blockIndex: number;
  path: string | null;
  error?: string;
  reason: PruneReason;
}

export interface PruneResult {
  messages: unknown[];
  pruned: PrunedImage[];
  totalImages: number;
  /** 剪枝前所有图片块的估算总体积(字节) */
  totalBytes: number;
  /** 剪枝后保留图片的估算体积(字节) */
  keptBytes: number;
  /** 剪枝后保留的图片数 */
  keptImages: number;
  overLimitInSingleMessage: boolean;
  /** 体积规则开启、只剩最后 1 张且该张自身仍超预算 → true(只提示, 不处理) */
  singleImageOverBudget: boolean;
}

export interface PruneDeps {
  maxImages: number;
  /** 体积预算(字节); `0` = 关闭体积规则 */
  maxImageBytes: number;
  /** 落盘 callback; 由调用方注入(扩展注入 createDumper().dump, 测试注入 fake) */
  dump(img: { hash: string; data: string; mimeType?: string }): { path: string } | { error: string };
}

/**
 * 单张图片体积估算: base64 文本长度 → 二进制字节(×3/4, 向上取整)。
 * 这是**偏保守的估算**, 不含 JSON 结构开销(引号/字段名/转义),
 * 所以默认预算取 provider 请求体上限 48 MiB 的一半。
 */
export function estimateBytes(data: unknown): number {
  return Math.ceil((String(data ?? "").length * 3) / 4);
}

/** 字节 → MiB 文本: 最多 1 位小数, 去掉多余的 `.0` (25165824 → "24 MiB", 524288 → "0.5 MiB") */
export function formatMiB(bytes: number): string {
  const rounded = Math.round((bytes / (1024 * 1024)) * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)} MiB`;
}

/** 张数规则的占位文字(精确格式, 进单测) */
export function placeholderText(max: number, path: string | null, error?: string): string {
  if (error !== undefined) {
    return `[早期图片已省略 · 超出单次请求上限 ${max} 张 · 落盘失败: ${error}]`;
  }
  return `[早期图片已省略 · 超出单次请求上限 ${max} 张 · 原图: ${path}]`;
}

/** 体积规则的占位文字(精确格式, 进单测) */
export function bytesPlaceholderText(
  maxBytes: number,
  path: string | null,
  error?: string
): string {
  const budget = formatMiB(maxBytes);
  if (error !== undefined) {
    return `[早期图片已省略 · 超出单次请求体积预算 ${budget} · 落盘失败: ${error}]`;
  }
  return `[早期图片已省略 · 超出单次请求体积预算 ${budget} · 原图: ${path}]`;
}

/**
 * 请求级图片剪枝。
 * - 两条规则都没触发 → undefined(零改动、保持引用)
 * - 触发 → 新 messages + 剪枝明细; 不修改入参
 *
 * 规则 1(张数): 全局剪最旧的 `totalImages - maxImages` 张, 硬保证剪后图片数 === maxImages。
 * 规则 2(体积): 张数规则之后再迭代, 只要 `keptBytes > maxImageBytes` 且 `keptCount > 1`,
 *               就继续剪最旧的一张; 至少保留最新 1 张。
 */
export function pruneImages(
  messages: readonly unknown[],
  deps: PruneDeps
): PruneResult | undefined {
  const refs = scanImages(messages);
  const totalImages = refs.length;
  const totalBytes = refs.reduce((sum, r) => sum + estimateBytes(r.data), 0);
  const bytesRuleOn = deps.maxImageBytes > 0;

  // 每条消息的图片数 (仅用于提示, 不影响剪枝结果)
  const countByMsg = new Map<number, number>();
  for (const ref of refs) {
    countByMsg.set(ref.msgIndex, (countByMsg.get(ref.msgIndex) ?? 0) + 1);
  }

  // 规则 1(张数): 全局剪最旧的 excess 张 —— 硬保证剪后 === maxImages
  const countExcess = Math.max(0, totalImages - deps.maxImages);

  // 规则 2(体积): 从张数规则留下的部分继续剪最旧的一张, 直到 <= 预算或只剩 1 张
  let pruneCount = countExcess;
  let keptBytes = refs
    .slice(pruneCount)
    .reduce((sum, r) => sum + estimateBytes(r.data), 0);
  if (bytesRuleOn) {
    while (keptBytes > deps.maxImageBytes && totalImages - pruneCount > 1) {
      keptBytes -= estimateBytes(refs[pruneCount].data);
      pruneCount++;
    }
  }

  // 两条规则都没触发 → 零改动、保持引用。
  // 例外: 体积超预算但已只剩 1 张(无可再剪)时仍返回结果, 供上层提示 singleImageOverBudget。
  const bytesOverBudget = bytesRuleOn && totalBytes > deps.maxImageBytes;
  if (pruneCount === 0 && !bytesOverBudget) return undefined;

  // pruned 永远是 refs 的最旧前缀: 前 countExcess 张因张数规则, 其余因体积规则
  const reasonByKey = new Map<string, PruneReason>();
  for (let i = 0; i < pruneCount; i++) {
    const ref = refs[i];
    reasonByKey.set(`${ref.msgIndex}:${ref.blockIndex}`, i < countExcess ? "count" : "bytes");
  }

  const keptImages = totalImages - pruneCount;
  const overLimitInSingleMessage = [...countByMsg.values()].some(
    (c) => c > deps.maxImages
  );
  const singleImageOverBudget =
    bytesRuleOn && keptImages === 1 && keptBytes > deps.maxImageBytes;

  const resultMessages: unknown[] = [];
  const pruned: PrunedImage[] = [];

  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi] as Record<string, unknown>;
    const content = msg.content;
    if (!Array.isArray(content)) {
      resultMessages.push(msg);
      continue;
    }

    let changed = false;
    for (let bi = 0; bi < content.length; bi++) {
      if (reasonByKey.has(`${mi}:${bi}`)) {
        changed = true;
        break;
      }
    }
    if (!changed) {
      resultMessages.push(msg);
      continue;
    }

    const newContent: unknown[] = [];
    for (let bi = 0; bi < content.length; bi++) {
      const reason = reasonByKey.get(`${mi}:${bi}`);
      if (reason === undefined) {
        newContent.push(content[bi]);
        continue;
      }
      const block = content[bi] as Record<string, unknown>;
      const data = String(block.data ?? "");
      const mimeType = block.mimeType === undefined ? undefined : String(block.mimeType);
      const hash = hashImage(data);

      let outcome: { path: string } | { error: string };
      try {
        outcome = deps.dump({ hash, data, mimeType });
      } catch (err) {
        outcome = { error: err instanceof Error ? err.message : String(err) };
      }

      const path = "path" in outcome ? outcome.path : null;
      const error = "error" in outcome ? outcome.error : undefined;
      const text =
        reason === "count"
          ? placeholderText(deps.maxImages, path, error)
          : bytesPlaceholderText(deps.maxImageBytes, path, error);

      const entry: PrunedImage = { hash, msgIndex: mi, blockIndex: bi, path, reason };
      if (error !== undefined) entry.error = error;
      pruned.push(entry);
      newContent.push({ type: "text", text });
    }

    resultMessages.push({ ...msg, content: newContent });
  }

  return {
    messages: resultMessages,
    pruned,
    totalImages,
    totalBytes,
    keptBytes,
    keptImages,
    overLimitInSingleMessage,
    singleImageOverBudget,
  };
}
