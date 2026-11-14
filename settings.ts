import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ObserverThinking = typeof THINKING_LEVELS[number];
export interface ObserverSettings { model: string | null; thinking: ObserverThinking }

export function defaultSettings(): ObserverSettings {
  return { model: null, thinking: "low" };
}

export function isThinking(value: unknown): value is ObserverThinking {
  return typeof value === "string" && THINKING_LEVELS.some((level) => level === value);
}

/** Match Pi's model catalog rules; never silently upgrade an unsupported level. */
export function supportsThinking(model: {
  reasoning: boolean;
  thinkingLevelMap?: Partial<Record<ObserverThinking, string | null>>;
}, level: ObserverThinking): boolean {
  // Non-reasoning models ignore the preference; no reasoning is sent to them.
  if (!model.reasoning) return true;
  const mapped = model.thinkingLevelMap?.[level];
  if (mapped === null) return false;
  return level !== "xhigh" && level !== "max" ? true : mapped !== undefined;
}

/** Split only the first slash: model IDs themselves may contain slashes. */
export function splitModel(value: string): { provider: string; id: string } | undefined {
  if (value !== value.trim() || /[\s\x00-\x1f\x7f-\x9f]/u.test(value)) return;
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return;
  return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

export function parseSettings(value: unknown): ObserverSettings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const item = value as Record<string, unknown>;
  if ((item.model !== null && (typeof item.model !== "string" || !splitModel(item.model))) || !isThinking(item.thinking)) return;
  return { model: item.model, thinking: item.thinking };
}

/** Match Pi's agent directory convention, including ~ in PI_CODING_AGENT_DIR. */
export function settingsPath(): string {
  const env = process.env.PI_CODING_AGENT_DIR;
  const agentDir = !env ? join(homedir(), ".pi", "agent")
    : env === "~" ? homedir()
    : env.startsWith("~/") ? join(homedir(), env.slice(2))
    : env;
  return join(agentDir, "you-should-know", "config.json");
}

/** Missing file uses defaults; corrupt/unreadable settings never silently fall back. */
export function readSettings(): ObserverSettings {
  let text: string;
  try {
    text = readFileSync(settingsPath(), "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return defaultSettings();
    throw new Error("Could not read observer settings");
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Observer settings are not valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid observer settings format");
  const record = value as Record<string, unknown>;
  const settings = record.version === 1 ? parseSettings(record) : undefined;
  if (!settings || Object.keys(record).some((key) => !["version", "model", "thinking"].includes(key))) {
    throw new Error("Invalid observer settings fields or version");
  }
  return settings;
}

/** Merge only the requested field, then atomically replace the settings file. */
export function saveSettingsPatch(patch: Partial<ObserverSettings>): ObserverSettings {
  const updated = parseSettings({ ...readSettings(), ...patch });
  if (!updated) throw new Error("Invalid observer settings");
  const path = settingsPath();
  const directory = dirname(path);
  const temporary = join(directory, `.config-${randomUUID()}.tmp`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temporary, `${JSON.stringify({ version: 1, ...updated }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch { /* renamed or never created */ }
  }
  return updated;
}
