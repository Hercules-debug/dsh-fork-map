/**
 * Fork 库的纯逻辑与快照文件读写（不依赖 DSH 服务，便于离线测试）。
 *
 * 一个 Fork = 某个会话在某一轮结束时的完整上下文快照。
 *   - 元数据存在 storage domain `fork_library` 的 `forks` 表里（DSH 自带的持久化）。
 *   - 事件前缀压缩后单独存成文件：<DSH_HOME>/storages/fork_library_snapshots/<id>.json.zst
 *   （实际目录名 fork_library_snapshots，避开 storage 后端自己的 fork_library.json）
 * 快照独立于源会话：源会话删了，Fork 照样能启动新会话。
 */
import { mkdir, readFile, rm, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as zlib from "node:zlib";

export const SNAPSHOT_VERSION = 1;

const hasZstd = typeof zlib.zstdCompress === "function" && typeof zlib.zstdDecompress === "function";
const compress = promisify(hasZstd ? zlib.zstdCompress : zlib.gzip);
const decompress = promisify(hasZstd ? zlib.zstdDecompress : zlib.gunzip);
const EXT = hasZstd ? ".json.zst" : ".json.gz";

export function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

export function snapshotDir(home = dshHome()) {
  return join(home, "storages", "fork_library_snapshots");
}

const ID_PATTERN = /^fork-[0-9a-f-]{36}$/;
export function isForkId(value) {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function snapshotPath(dir, id) {
  if (!isForkId(id)) throw new Error(`invalid fork id: ${String(id)}`);
  return join(dir, id + EXT);
}

/** 原子写：先写临时文件再 rename，避免半截快照。 */
export async function writeSnapshot(dir, id, snapshot) {
  await mkdir(dir, { recursive: true });
  const finalPath = snapshotPath(dir, id);
  const tmp = finalPath + ".tmp-" + process.pid;
  const bytes = await compress(Buffer.from(JSON.stringify(snapshot), "utf8"));
  await writeFile(tmp, bytes);
  await rename(tmp, finalPath);
  return bytes.length;
}

export async function readSnapshot(dir, id) {
  const raw = await readFile(snapshotPath(dir, id));
  const parsed = JSON.parse((await decompress(raw)).toString("utf8"));
  if (parsed?.version !== SNAPSHOT_VERSION || !Array.isArray(parsed.events)) {
    throw new Error(`fork snapshot ${id} has an unsupported format`);
  }
  return parsed;
}

export async function deleteSnapshot(dir, id) {
  await rm(snapshotPath(dir, id), { force: true });
}

/**
 * 计算切点，规则与 DSH 原生 fork 完全一致：
 * 边界 = 锚点之后的第一个 turn/end；切点 = 边界之后第一个 turn/start（或日志末尾）。
 * @param events - 源会话完整事件日志（seq 与下标一致）。
 * @param anchorSeq - 锚点事件 seq；省略时取最后一个完成的轮次。
 * @returns {{ cut: number, boundarySeq: number } | undefined}
 */
export function completedTurnCut(events, anchorSeq) {
  const lastSeq = events.at(-1)?.seq ?? -1;
  let boundary;
  if (anchorSeq !== undefined) {
    boundary = events.find((e) => e.type === "turn/end" && e.seq >= anchorSeq);
  }
  if (boundary === undefined && (anchorSeq === undefined || anchorSeq > lastSeq)) {
    boundary = events.findLast((e) => e.type === "turn/end");
  }
  if (boundary === undefined) return undefined;
  let cut = boundary.seq + 1;
  while (cut < events.length && events[cut]?.type !== "turn/start") cut += 1;
  return { cut, boundarySeq: boundary.seq };
}

/** 找到某条 assistant 消息所在的事件 seq。 */
export function seqOfAssistantMessage(events, messageId) {
  const hit = events.find((e) => e.type === "assistant/message" && e.data?.message?.id === messageId);
  return hit?.seq;
}

function textOf(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function clip(text, max) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** 从快照前缀里提炼卡片展示用的摘要信息。 */
export function summarizePrefix(events) {
  let turns = 0;
  let lastUser = "";
  let lastAssistant = "";
  let firstUser = "";
  for (const e of events) {
    if (e.type === "turn/end") turns += 1;
    else if (e.type === "user/message" && e.data?.source?.kind === "user") {
      const t = textOf(e.data?.content);
      if (t !== "") {
        if (firstUser === "") firstUser = t;
        lastUser = t;
      }
    } else if (e.type === "assistant/message") {
      const t = textOf(e.data?.message?.content);
      if (t !== "") lastAssistant = t;
    }
  }
  return {
    turns,
    firstUser: clip(firstUser, 120),
    lastUser: clip(lastUser, 160),
    lastAssistant: clip(lastAssistant, 240),
  };
}

/** 源会话标题（取最后一条 session/title 事件）。 */
export function titleOf(events) {
  let title = "";
  for (const e of events) {
    if (e.type === "session/title" && typeof e.data?.title === "string") title = e.data.title;
  }
  return title;
}

export function cleanText(value, max) {
  if (typeof value !== "string") return undefined;
  const s = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return s.slice(0, max);
}

/**
 * 把快照还原成模型当时看到的上下文：按 DSH 的 surface 规则折叠
 * （append 追加；replace 用压缩摘要替换一段区间），再把每个节点转成消息。
 * 与 dsh-session 的 foldSurface + deriveEventMessage 等价；插件目录不在
 * DSH 的依赖树里，无法直接 import，所以这里按同样规则实现。
 * route 是这段对话最后一次请求用的模型，命名时沿用它，可以命中同一份提示缓存。
 * @returns {{ messages: object[], tools?: object[], route?: {provider: string, model: string} }}
 */
const SURFACE_TYPES = new Set(["system/message", "user/message", "assistant/message", "tool/result"]);
export function contextOf(events) {
  const nodes = [];
  let tools;
  let route;
  for (const e of events) {
    if (e.type === "request/header") {
      const h = e.data?.header;
      const t = h?.tools;
      tools = Array.isArray(t) && t.length > 0 ? t : undefined;
      if (typeof h?.config?.provider === "string" && typeof h?.config?.model === "string") {
        route = { provider: h.config.provider, model: h.config.model };
      }
      continue;
    }
    if (!SURFACE_TYPES.has(e.type)) continue;
    const op = e.surfaceOp;
    if (op === "append") nodes.push(e);
    else if (op && op.op === "replace") {
      const a = nodes.findIndex((n) => n.seq === op.startSeq);
      const b = nodes.findIndex((n) => n.seq === op.endSeq);
      if (a < 0 || b < a) throw new Error(`surface replace at seq ${e.seq} has an invalid range`);
      nodes.splice(a, b - a + 1, e);
    }
  }
  const messages = [];
  for (const e of nodes) {
    let m = null;
    if (e.type === "user/message") m = e.data;
    else if (e.type === "tool/result") m = e.data?.message;
    else {
      const msg = e.data?.message;
      m = msg && Array.isArray(msg.content) && msg.content.length > 0 ? msg : null;
    }
    if (m) messages.push(m);
  }
  return { messages, ...(tools ? { tools } : {}), ...(route ? { route } : {}) };
}

/**
 * Fork 自己起名时追加在上下文末尾的那条消息。只用于这一次模型调用，
 * 不写进快照、也不写进任何会话。
 */
export function namingPrompt(parent) {
  const lines = [
    "【系统操作，不是用户的新问题】这段对话刚刚在这里被保存为一个 Fork（上下文快照），以后会从这里开启新会话继续工作。",
    "请根据你在这段对话里的完整上下文，给这个 Fork 起名并写备注。不要调用任何工具，不要继续之前的任务。",
  ];
  if (parent && (parent.label || parent.note)) {
    lines.push(
      "",
      "这段对话是从另一个 Fork 启动后继续进行的。父 Fork：",
      "名称：" + (parent.label || "（无）"),
      "备注：" + (parent.note || "（无）"),
      "名字要能和父 Fork 区分开；备注写清楚相对父 Fork 又往前做了什么。",
    );
  }
  lines.push(
    "",
    "name：4 到 16 个字，概括到这里为止这段上下文在做什么，用对话所用的语言。",
    "note：一到两句话，说明到这里已经完成了什么、停在哪里、适合从这里接着做什么，不超过 120 字。",
    '只输出一个 JSON 对象，不要其它文字：{"name": "...", "note": "..."}',
  );
  return lines.join("\n");
}

/** 从模型回复里取出 {name, note}；容忍 ```json 包裹和前后多余文字。 */
export function parseNaming(text) {
  const s = String(text ?? "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const obj = JSON.parse(s.slice(start, end + 1));
    const name = cleanText(obj?.name, 40);
    const note = cleanText(obj?.note, 300);
    if (!name) return undefined;
    return { name, note: note ?? "" };
  } catch {
    return undefined;
  }
}
