import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export type Src = "env" | "file" | "default";

export interface Sources {
  enabled: Src;
  maxImages: Src;
  maxImageBytes: Src;
  dumpDir: Src;
  retentionDays: Src;
}

export interface ResolvedConfig {
  enabled: boolean;
  maxImages: number;
  /** 单次请求图片估算总体积预算(字节); `0` = 关闭体积规则 */
  maxImageBytes: number;
  /** 绝对路径 */
  dumpDir: string;
  retentionDays: number;
  sources: Sources;
  warnings: string[];
}

export const DEFAULTS = {
  enabled: true,
  maxImages: 10,
  maxImageBytes: 25165824,
  dumpDir: "~/.pi/agent/image-prune",
  retentionDays: 7,
} as const;

const TRUTHY = new Set(["on", "1", "true", "yes"]);
const FALSY = new Set(["off", "0", "false", "no"]);

/** `~` 展开为 home; 相对路径按 home 解析; 绝对路径原样 */
function expandPath(p: string, home: string): string {
  let out = p;
  if (out === "~") return home;
  if (out.startsWith("~/")) out = out.slice(2);
  return isAbsolute(out) ? out : join(home, out);
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1;
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/**
 * 三层配置解析: 环境变量 > 配置文件 > 内建默认。
 * 逐键回落(非法键只影响自己); 每条问题追加一条 warning。
 */
export function resolveConfig(
  opts: {
    env?: NodeJS.ProcessEnv;
    home?: string;
    configPath?: string;
    readFile?: (p: string) => string;
  } = {}
): ResolvedConfig {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const configPath = opts.configPath ?? join(home, ".pi", "agent", "image-prune.json");

  const warnings: string[] = [];
  const sources: Sources = {
    enabled: "default",
    maxImages: "default",
    maxImageBytes: "default",
    dumpDir: "default",
    retentionDays: "default",
  };

  let enabled: boolean = DEFAULTS.enabled;
  let maxImages: number = DEFAULTS.maxImages;
  let maxImageBytes: number = DEFAULTS.maxImageBytes;
  let dumpDirRaw: string = DEFAULTS.dumpDir;
  let retentionDays: number = DEFAULTS.retentionDays;

  // ---- 文件层 ----
  let fileCfg: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(readFile(configPath));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      fileCfg = parsed as Record<string, unknown>;
    } else {
      warnings.push(`配置文件不是 JSON 对象, 全部使用默认值: ${configPath}`);
    }
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code !== "ENOENT") {
      warnings.push(
        `读取或解析配置文件失败, 全部使用默认值: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  if (fileCfg) {
    if ("enabled" in fileCfg) {
      if (typeof fileCfg.enabled === "boolean") {
        enabled = fileCfg.enabled;
        sources.enabled = "file";
      } else {
        warnings.push(`配置项 enabled 非法(须为 boolean), 使用默认值 ${DEFAULTS.enabled}`);
      }
    }
    if ("maxImages" in fileCfg) {
      if (isPositiveInt(fileCfg.maxImages)) {
        maxImages = fileCfg.maxImages;
        sources.maxImages = "file";
      } else {
        warnings.push(
          `配置项 maxImages 非法(须为 >=1 的整数), 使用默认值 ${DEFAULTS.maxImages}`
        );
      }
    }
    if ("maxImageBytes" in fileCfg) {
      if (isNonNegativeInt(fileCfg.maxImageBytes)) {
        maxImageBytes = fileCfg.maxImageBytes;
        sources.maxImageBytes = "file";
      } else {
        warnings.push(
          `配置项 maxImageBytes 非法(须为 >=0 的整数), 使用默认值 ${DEFAULTS.maxImageBytes}`
        );
      }
    }
    if ("dumpDir" in fileCfg) {
      if (typeof fileCfg.dumpDir === "string" && fileCfg.dumpDir.length > 0) {
        dumpDirRaw = fileCfg.dumpDir;
        sources.dumpDir = "file";
      } else {
        warnings.push(
          `配置项 dumpDir 非法(须为非空字符串), 使用默认值 ${DEFAULTS.dumpDir}`
        );
      }
    }
    if ("retentionDays" in fileCfg) {
      if (isNonNegativeInt(fileCfg.retentionDays)) {
        retentionDays = fileCfg.retentionDays;
        sources.retentionDays = "file";
      } else {
        warnings.push(
          `配置项 retentionDays 非法(须为 >=0 的整数), 使用默认值 ${DEFAULTS.retentionDays}`
        );
      }
    }
  }

  // ---- 环境变量层 ----
  const rawEnabled = env.PI_IMAGE_PRUNE;
  if (rawEnabled !== undefined && rawEnabled !== "") {
    const v = rawEnabled.trim().toLowerCase();
    if (TRUTHY.has(v)) {
      enabled = true;
      sources.enabled = "env";
    } else if (FALSY.has(v)) {
      enabled = false;
      sources.enabled = "env";
    } else {
      warnings.push(`环境变量 PI_IMAGE_PRUNE 值非法: ${rawEnabled}(忽略)`);
    }
  }

  const rawMax = env.PI_IMAGE_PRUNE_MAX;
  if (rawMax !== undefined && rawMax !== "") {
    const t = rawMax.trim();
    if (/^\d+$/.test(t) && Number.parseInt(t, 10) >= 1) {
      maxImages = Number.parseInt(t, 10);
      sources.maxImages = "env";
    } else {
      warnings.push(`环境变量 PI_IMAGE_PRUNE_MAX 非法(须为 >=1 的整数): ${rawMax}(忽略)`);
    }
  }

  const rawDir = env.PI_IMAGE_PRUNE_DUMP_DIR;
  if (rawDir !== undefined && rawDir !== "") {
    dumpDirRaw = rawDir;
    sources.dumpDir = "env";
  }

  const rawMaxBytes = env.PI_IMAGE_PRUNE_MAX_BYTES;
  if (rawMaxBytes !== undefined && rawMaxBytes !== "") {
    const t = rawMaxBytes.trim();
    if (/^\d+$/.test(t) && Number.isSafeInteger(Number.parseInt(t, 10))) {
      maxImageBytes = Number.parseInt(t, 10);
      sources.maxImageBytes = "env";
    } else {
      warnings.push(
        `环境变量 PI_IMAGE_PRUNE_MAX_BYTES 非法(须为 >=0 的整数): ${rawMaxBytes}(忽略)`
      );
    }
  }

  return {
    enabled,
    maxImages,
    maxImageBytes,
    dumpDir: expandPath(dumpDirRaw, home),
    retentionDays,
    sources,
    warnings,
  };
}
