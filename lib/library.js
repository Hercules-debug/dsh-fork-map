/**
 * ForkLibrary：保存 / 启动 / 编辑 / 删除 Fork。只依赖构造时传入的服务，便于离线测试。
 */
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import {
  cleanText,
  completedTurnCut,
  deleteSnapshot,
  isForkId,
  readSnapshot,
  seqOfAssistantMessage,
  snapshotDir,
  SNAPSHOT_VERSION,
  parseNaming,
  summarizePrefix,
  titleOf,
  contextOf,
  namingPrompt,
  writeSnapshot,
} from "./store.js";

const TAG = "[dsh-fork-map]";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function passthroughSchema() {
  return { parse: (v) => v, safeParse: (v) => ({ success: true, data: v }) };
}

export function json(status, body) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function body(request) {
  const text = await request.text();
  if (text.length > 64 * 1024) throw new HttpError(413, "body too large");
  try {
    const parsed = text === "" ? {} : JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new HttpError(400, "body must be a JSON object");
  }
}

function rec_label(label) {
  return Boolean(cleanText(label, 80));
}

function requireId(value, label) {
  if (typeof value !== "string" || value === "" || value.length > 200) throw new HttpError(400, `${label} required`);
  return value;
}

async function canonical(path) {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/**
 * Fork 库服务本体。只依赖构造时传入的 services，便于理解和测试。
 */
export class ForkLibrary {
  constructor(services, forks, dir) {
    this.s = services;
    this.forks = forks;
    this.dir = dir;
  }

  list() {
    return [...this.forks.entries()].map(([, v]) => v).sort((a, b) => b.createdAt - a.createdAt);
  }

  require(forkId) {
    if (!isForkId(forkId)) throw new HttpError(400, "invalid forkId");
    const rec = this.forks.get(forkId);
    if (rec === undefined) throw new HttpError(404, `fork ${forkId} not found`);
    return rec;
  }

  /** 把某会话某一轮结束时的上下文存成 Fork。同一会话同一边界只存一份。 */
  async save({ sessionId, messageId, atSeq, label }) {
    requireId(sessionId, "sessionId");
    let observed;
    try {
      observed = await this.s.sessionQuery.observeSession(sessionId);
    } catch (error) {
      throw new HttpError(404, `session ${sessionId} unavailable: ${String(error?.message ?? error)}`);
    }
    try {
      const header = observed.header;
      if (header.origin === "subagent") throw new HttpError(400, "subagent sessions cannot be saved as forks");
      if (header.cwd === undefined) throw new HttpError(400, "session has no cwd");
      const events = observed.events;
      let anchor = typeof atSeq === "number" && Number.isSafeInteger(atSeq) && atSeq >= 0 ? atSeq : undefined;
      if (typeof messageId === "string" && messageId !== "") {
        const found = seqOfAssistantMessage(events, messageId);
        if (found === undefined) throw new HttpError(404, "message not found in session");
        anchor = found;
      }
      const cut = completedTurnCut(events, anchor);
      if (cut === undefined) throw new HttpError(409, "该轮尚未完成，无法存为 Fork");

      for (const rec of this.list()) {
        if (rec.source.sessionId === sessionId && rec.source.boundarySeq === cut.boundarySeq) {
          return { fork: rec, existed: true };
        }
      }

      const prefix = events.slice(0, cut.cut);
      const id = `fork-${randomUUID()}`;
      const agentPreset = observed.projections?.values?.agentPreset ?? header.agentPreset ?? undefined;
      const bytes = await writeSnapshot(this.dir, id, {
        version: SNAPSHOT_VERSION,
        cwd: header.cwd,
        ...(agentPreset ? { agentPreset } : {}),
        events: prefix,
      });
      const summary = summarizePrefix(prefix);
      const sourceTitle = observed.projections?.values?.title ?? titleOf(prefix);
      const parentFork = this.list().find((f) => f.launches.some((l) => l.sessionId === sessionId));
      const rec = {
        id,
        version: 1,
        cwd: await canonical(header.cwd),
        label: cleanText(label, 80) || "",
        note: "",
        createdAt: Date.now(),
        source: {
          sessionId,
          title: typeof sourceTitle === "string" ? sourceTitle : "",
          boundarySeq: cut.boundarySeq,
          eventCount: prefix.length,
        },
        ...(parentFork ? { parentForkId: parentFork.id } : {}),
        ...(agentPreset ? { agentPreset } : {}),
        summary,
        bytes,
        launches: [],
        ...(this.s.llm && !rec_label(label) ? { naming: "pending" } : {}),
      };
      await this.forks.put(id, rec);
      if (rec.naming === "pending") void this.autoName(id, sessionId, prefix);
      this.s.logger?.info?.(`${TAG} saved ${id} from ${sessionId}@${cut.boundarySeq} (${prefix.length} events, ${bytes} bytes)`);
      return { fork: rec, existed: false };
    } finally {
      observed[Symbol.dispose]?.();
    }
  }

  /** 从 Fork 启动一个全新的普通会话。 */
  async launch({ forkId }) {
    const rec = this.require(forkId);
    let snap;
    try {
      snap = await readSnapshot(this.dir, rec.id);
    } catch (error) {
      throw new HttpError(410, `fork snapshot unreadable: ${String(error?.message ?? error)}`);
    }
    const controller = this.s.sessionController;
    // 与原生 fork 相同的组装器与所有者：会话由 session controller 的 fiber 持有，
    // 本插件热重载不会把已启动的会话带走。
    const owner = controller?.agents;
    const agents = owner?.ctx?.agents ?? this.s.agents;
    let composition;
    try {
      composition = await owner.composeAgent(snap.agentPreset);
    } catch {
      composition = await owner.composeAgent(undefined);
    }
    const childId = `session-${randomUUID()}`;
    const { provider, model } = this.s.agentDefaultModel.currentSelection();
    await agents.create({
      sessionId: childId,
      seed: snap.events,
      inheritedEventCount: snap.events.length,
      meta: {
        cwd: snap.cwd,
        isSeeded: true,
        ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
      },
      agentOptions: { provider, model },
      setup: composition.setup,
    });

    const title = this.titleForLaunch(rec);
    try {
      const titles = this.s.ctx.get("sessionTitle");
      const live = this.s.sessions.get(childId);
      if (titles !== undefined && live !== undefined && title !== "") titles.rename(live, title);
    } catch (error) {
      this.s.logger?.warn?.(`${TAG} rename ${childId} failed: ${String(error)}`);
    }

    try {
      const path = await canonical(snap.cwd);
      // 与原生 fork 一致：只挂进已存在的工作区，不替用户新建工作区
      const ws = this.s.workspaceRegistry.list().find((w) => w.path === path);
      if (ws !== undefined) await ws.attachSession(childId);
    } catch (error) {
      this.s.logger?.warn?.(`${TAG} attach ${childId} to workspace failed: ${String(error)}`);
    }

    await this.forks.update(rec.id, (cur) => ({
      ...cur,
      launches: [...cur.launches, { sessionId: childId, at: Date.now() }],
    }));
    this.s.logger?.info?.(`${TAG} launched ${childId} from ${rec.id}`);
    return { sessionId: childId };
  }

  /**
   * 让 Fork 自己起名：把快照还原成模型当时看到的完整上下文，末尾临时追加一条
   * 命名请求（有父 Fork 时带上父 Fork 的名字和备注），一次性调用模型。
   * 这条请求和模型的回答只存在于这次调用里，不写进快照，也不写进任何会话。
   * 失败不影响 Fork 本身；用户手动改过的名字或备注不会被覆盖。
   */
  async autoName(forkId, sessionId, events) {
    let result;
    try {
      const context = contextOf(events);
      if (context.messages.length === 0) throw new Error("empty context");
      const rec = this.forks.get(forkId);
      const parent = rec?.parentForkId ? this.forks.get(rec.parentForkId) : undefined;
      const messages = [
        ...context.messages,
        {
          id: randomUUID(),
          role: "user",
          content: [{ type: "text", text: namingPrompt(parent) }],
          source: { kind: "plugin", plugin: "dsh-fork-map" },
        },
      ];
      // 优先用这段对话自己最后一次用的模型（前缀一致，能命中提示缓存）；
      // 该模型已不可用时退回当前默认模型。
      const fallback = this.s.agentDefaultModel.currentSelection();
      const routes = [context.route, fallback].filter(
        (r, i, all) => r && all.findIndex((o) => o && o.provider === r.provider && o.model === r.model) === i,
      );
      let lastError;
      for (const route of routes) {
        try {
          result = await this.askName(route, messages, context.tools, sessionId);
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (result === undefined) throw lastError ?? new Error("no model route");
    } catch (error) {
      this.s.logger?.warn?.(`${TAG} naming ${forkId} failed: ${String(error?.message ?? error)}`);
    }
    if (this.forks.get(forkId) === undefined) return;
    await this.forks.update(forkId, (cur) => ({
      ...cur,
      naming: result ? "done" : "failed",
      ...(result && !cur.label ? { label: result.name } : {}),
      ...(result && !cur.note ? { note: result.note } : {}),
    }));
  }

  /** 一次性模型调用，返回 {name, note}；只在内存里，不落任何会话。 */
  async askName(route, messages, tools, sessionId) {
    let text = "";
    let failure;
    for await (const chunk of this.s.llm.stream({
      provider: route.provider,
      model: route.model,
      messages,
      // 保留工具定义只为让请求前缀与原对话一致；提示里要求不调用工具
      ...(tools ? { tools } : {}),
      maxTokens: 4096,
      sessionId,
    })) {
      if (chunk.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
      else if (chunk.type === "finish" && chunk.reason !== undefined && chunk.reason.kind !== "stop") {
        failure = chunk.reason.failure?.message ?? chunk.reason.kind;
      }
    }
    const parsed = parseNaming(text);
    if (parsed === undefined) throw new Error(failure ? `llm finish: ${failure}` : "unparseable reply: " + text.slice(0, 200));
    return parsed;
  }

  /** 手动触发重新命名（覆盖现有名字和备注）。 */
  async rename({ forkId }) {
    const rec = this.require(forkId);
    if (!this.s.llm) throw new HttpError(503, "llm service unavailable");
    let snap;
    try {
      snap = await readSnapshot(this.dir, rec.id);
    } catch (error) {
      throw new HttpError(410, `fork snapshot unreadable: ${String(error?.message ?? error)}`);
    }
    const fork = await this.forks.update(forkId, (cur) => ({ ...cur, naming: "pending", label: "", note: "" }));
    void this.autoName(forkId, rec.source.sessionId, snap.events);
    return { fork };
  }

  titleForLaunch(rec) {
    const base = rec.label || rec.source.title || rec.summary?.firstUser || "Fork";
    return `${base} · Fork ${rec.launches.length + 1}`.slice(0, 120);
  }

  async update({ forkId, label, note }) {
    this.require(forkId);
    const next = await this.forks.update(forkId, (cur) => ({
      ...cur,
      ...(label === undefined ? {} : { label: cleanText(label, 80) ?? "" }),
      ...(note === undefined ? {} : { note: cleanText(note, 2000) ?? "" }),
    }));
    return { fork: next };
  }

  async remove({ forkId }) {
    this.require(forkId);
    await this.forks.delete(forkId);
    await deleteSnapshot(this.dir, forkId);
    // 子 Fork 的 parentForkId 断开，避免悬空引用
    for (const f of this.list()) {
      if (f.parentForkId === forkId) {
        await this.forks.update(f.id, (cur) => {
          const { parentForkId: _drop, ...rest } = cur;
          return rest;
        });
      }
    }
    return { deleted: true };
  }
}

