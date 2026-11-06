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
