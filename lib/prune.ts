import { scanImages } from "./scan.ts";
import { hashImage } from "./dump.ts";

export interface PrunedImage {
  hash: string;
  msgIndex: number;
  blockIndex: number;
  path: string | null;
  error?: string;
}

export interface PruneResult {
  messages: unknown[];
  pruned: PrunedImage[];
  totalImages: number;
  overLimitInSingleMessage: boolean;
}

export interface PruneDeps {
  maxImages: number;
  /** 落盘 callback; 由调用方注入(扩展注入 createDumper().dump, 测试注入 fake) */
  dump(img: { hash: string; data: string; mimeType?: string }): { path: string } | { error: string };
}

/** 占位文字(精确格式, 进单测) */
export function placeholderText(max: number, path: string | null, error?: string): string {
  if (error !== undefined) {
    return `[早期图片已省略 · 超出单次请求上限 ${max} 张 · 落盘失败: ${error}]`;
  }
  return `[早期图片已省略 · 超出单次请求上限 ${max} 张 · 原图: ${path}]`;
}

/**
 * 请求级图片剪枝。
 * - 未超限 → undefined(零改动、保持引用)
 * - 超限 → 新 messages + 剪枝明细; 不修改入参
 */
export function pruneImages(
  messages: readonly unknown[],
  deps: PruneDeps
): PruneResult | undefined {
  const refs = scanImages(messages);
  if (refs.length <= deps.maxImages) return undefined;

  // 每条消息的图片数
  const countByMsg = new Map<number, number>();
  for (const ref of refs) {
    countByMsg.set(ref.msgIndex, (countByMsg.get(ref.msgIndex) ?? 0) + 1);
  }

  // 每条消息最多可剪的张数:
  //   消息自身超过 maxImages → 只保留该消息内最后 maxImages 张(最多剪 count - max)
  //   消息自身未超过 maxImages → 该消息全部图片都可被全局规则剪掉
  const maxPruneByMsg = new Map<number, number>();
  for (const [mi, count] of countByMsg) {
    maxPruneByMsg.set(mi, count > deps.maxImages ? count - deps.maxImages : count);
  }

  // 从全局最旧的开始剪, 直到剪够 (总数 - maxImages) 张; 受每条消息上限约束
  let excess = refs.length - deps.maxImages;
  const prunedKeys = new Set<string>();
  const prunedCountByMsg = new Map<number, number>();
  for (const ref of refs) {
    if (excess <= 0) break;
    const done = prunedCountByMsg.get(ref.msgIndex) ?? 0;
    const cap = maxPruneByMsg.get(ref.msgIndex) ?? 0;
    if (done < cap) {
      prunedKeys.add(`${ref.msgIndex}:${ref.blockIndex}`);
      prunedCountByMsg.set(ref.msgIndex, done + 1);
      excess--;
    }
  }

  const overLimitInSingleMessage = [...countByMsg.values()].some(
    (c) => c > deps.maxImages
  );

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
      if (prunedKeys.has(`${mi}:${bi}`)) {
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
      if (!prunedKeys.has(`${mi}:${bi}`)) {
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

      if ("path" in outcome) {
        pruned.push({ hash, msgIndex: mi, blockIndex: bi, path: outcome.path });
        newContent.push({ type: "text", text: placeholderText(deps.maxImages, outcome.path) });
      } else {
        pruned.push({
          hash,
          msgIndex: mi,
          blockIndex: bi,
          path: null,
          error: outcome.error,
        });
        newContent.push({
          type: "text",
          text: placeholderText(deps.maxImages, null, outcome.error),
        });
      }
    }

    resultMessages.push({ ...msg, content: newContent });
  }

  return {
    messages: resultMessages,
    pruned,
    totalImages: refs.length,
    overLimitInSingleMessage,
  };
}
