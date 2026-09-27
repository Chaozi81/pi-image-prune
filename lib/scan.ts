export interface ImageRef {
  msgIndex: number;
  blockIndex: number;
  data: string;
  mimeType?: string;
}

/** 按出现顺序返回所有图片块位置 */
export function scanImages(messages: readonly unknown[]): ImageRef[] {
  const refs: ImageRef[] = [];
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi] as Record<string, unknown>;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (let bi = 0; bi < content.length; bi++) {
      const block = content[bi];
      if (block && typeof block === "object" && (block as Record<string, unknown>).type === "image") {
        const b = block as Record<string, unknown>;
        refs.push({
          msgIndex: mi,
          blockIndex: bi,
          data: String(b.data ?? ""),
          mimeType: b.mimeType === undefined ? undefined : String(b.mimeType),
        });
      }
    }
  }
  return refs;
}
