import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { completedTurnCut, contextOf, readSnapshot, summarizePrefix } from "../lib/store.js";
import { ForkLibrary } from "../lib/library.js";

const SURFACE = new Set(["system/message", "user/message", "assistant/message", "tool/result"]);
const ev = (seq, type, data = {}) => ({ seq, type, time: 1000 + seq, data, ...(SURFACE.has(type) ? { surfaceOp: "append" } : {}) });

/** 两轮对话 + 第三轮进行中 */
function sampleEvents() {
  return [
    ev(0, "session/title", { title: "示例会话" }),
    ev(1, "turn/start"),
    ev(2, "user/message", { source: { kind: "user" }, content: [{ type: "text", text: "第一问" }] }),
    ev(3, "assistant/message", { message: { id: "m1", content: [{ type: "text", text: "第一答" }] } }),
    ev(4, "turn/end"),
    ev(5, "model/selection", {}),
    ev(6, "turn/start"),
    ev(7, "user/message", { source: { kind: "user" }, content: [{ type: "text", text: "第二问" }] }),
    ev(8, "assistant/message", { message: { id: "m2", content: [{ type: "text", text: "第二答" }] } }),
    ev(9, "turn/end"),
    ev(10, "turn/start"),
    ev(11, "user/message", { source: { kind: "user" }, content: [{ type: "text", text: "第三问" }] }),
  ];
}

test("completedTurnCut matches native fork rules", () => {
  const events = sampleEvents();
  assert.deepEqual(completedTurnCut(events, 3), { cut: 6, boundarySeq: 4 });
  assert.deepEqual(completedTurnCut(events, 8), { cut: 10, boundarySeq: 9 });
  assert.deepEqual(completedTurnCut(events), { cut: 10, boundarySeq: 9 });
  assert.equal(completedTurnCut(events, 11), undefined, "open turn is unavailable");
  assert.equal(completedTurnCut(events.slice(0, 3)), undefined);
});

test("summarizePrefix", () => {
  const s = summarizePrefix(sampleEvents().slice(0, 10));
  assert.equal(s.turns, 2);
  assert.equal(s.firstUser, "第一问");
  assert.equal(s.lastUser, "第二问");
  assert.equal(s.lastAssistant, "第二答");
});

function fakeTable() {
  const m = new Map();
  return {
    get: (k) => m.get(k),

    entries: () => m.entries(),
    put: async (k, v) => void m.set(k, v),
    update: async (k, fn) => {
      const next = fn(m.get(k));
      m.set(k, next);
      return next;
    },
    delete: async (k) => m.delete(k),
  };
}

function fakeServices(store) {
  const created = [];
  const attached = [];
  const renamed = [];
  const services = {
    ctx: { get: (n) => (n === "sessionTitle" ? { rename: (s, t) => renamed.push([s.id, t]) } : undefined) },
    logger: { info() {}, warn() {} },
    sessionQuery: {
      observeSession: async (id) => {
        if (!store.has(id)) throw new Error("not found");
        return { header: { id, cwd: "/tmp", isSeeded: false }, events: store.get(id), projections: { values: { title: "示例会话" } }, [Symbol.dispose]() {} };
      },
    },
    sessions: { get: (id) => ({ id }) },
    agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) },
    workspaceRegistry: { list: () => [{ path: realpathSync("/tmp"), attachSession: async (id) => void attached.push(id) }] },
    sessionController: {
      agents: {
        composeAgent: async (preset) => ({ agentPreset: preset ?? "default", setup: () => {} }),
        ctx: { agents: { create: async (o) => void created.push(o) } },
      },
    },
  };
  return { services, created, attached, renamed };
}

test("save → launch twice → source deleted → launch still works → delete", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fork-lib-"));
  try {
    const sessions = new Map([["s1", sampleEvents()]]);
    const { services, created, attached, renamed } = fakeServices(sessions);
    const lib = new ForkLibrary(services, fakeTable(), dir);

    const { fork, existed } = await lib.save({ sessionId: "s1", messageId: "m1" });
    assert.equal(existed, false);
    assert.equal(fork.source.boundarySeq, 4);
    assert.equal(fork.source.eventCount, 6);
    assert.equal(fork.summary.turns, 1);
    const again = await lib.save({ sessionId: "s1", messageId: "m1" });
    assert.equal(again.existed, true, "same boundary is deduplicated");

    const snap = await readSnapshot(dir, fork.id);
    assert.equal(snap.events.length, 6);
    assert.equal(snap.events.at(-1).type, "model/selection");

    const a = await lib.launch({ forkId: fork.id });
    sessions.delete("s1"); // 源会话被删
    const b = await lib.launch({ forkId: fork.id });
    assert.notEqual(a.sessionId, b.sessionId);
    assert.equal(created.length, 2);
    assert.equal(created[0].inheritedEventCount, 6);
    assert.equal(created[0].meta.isSeeded, true);
    assert.equal(created[0].meta.parentSession, undefined);
    assert.equal(created[0].meta.cwd, "/tmp");
    assert.deepEqual(attached, [a.sessionId, b.sessionId]);
    assert.equal(renamed[1][1], "示例会话 · Fork 2");
    assert.equal(lib.require(fork.id).launches.length, 2);

    // 从启动出来的会话再存 Fork → 形成子 Fork
    sessions.set(a.sessionId, sampleEvents());
    const child = await lib.save({ sessionId: a.sessionId, messageId: "m2" });
    assert.equal(child.fork.parentForkId, fork.id);

    await lib.update({ forkId: fork.id, label: "  基线\n", note: "备注" });
    assert.equal(lib.require(fork.id).label, "基线");
    await lib.remove({ forkId: fork.id });
    assert.equal(lib.require(child.fork.id).parentForkId, undefined);
    assert.equal((await readdir(dir)).length, 1);
    await assert.rejects(lib.launch({ forkId: fork.id }), /not found/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("open turn cannot be saved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fork-lib-"));
  try {
    const { services } = fakeServices(new Map([["s1", sampleEvents().slice(0, 4)]]));
    const lib = new ForkLibrary(services, fakeTable(), dir);
    await assert.rejects(lib.save({ sessionId: "s1" }), /尚未完成/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("auto naming fills label and note, keeps manual edits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fork-lib-"));
  try {
    const { services } = fakeServices(new Map([["s1", sampleEvents()]]));
    const prompts = [];
    services.llm = {
      async *stream(o) {
        prompts.push(o);
        yield { type: "text-delta", text: '```json\n{"name":"示例问答","note":"已回答两问。"}\n```' };
        yield { type: "finish", reason: { kind: "stop" } };
      },
    };
    const lib = new ForkLibrary(services, fakeTable(), dir);
    const { fork } = await lib.save({ sessionId: "s1" });
    assert.equal(fork.naming, "pending");
    await new Promise((r) => setTimeout(r, 20));
    const named = lib.require(fork.id);
    assert.equal(named.naming, "done");
    assert.equal(named.label, "示例问答");
    assert.equal(named.note, "已回答两问。");
    // 完整上下文原样回放，末尾只多一条临时命名请求；快照本身不变
    const msgs = prompts[0].messages;
    assert.deepEqual(msgs.slice(0, -1).map((m) => m.content[0].text), ["第一问", "第一答", "第二问", "第二答"]);
    assert.match(msgs.at(-1).content[0].text, /保存为一个 Fork/);
    assert.doesNotMatch(msgs.at(-1).content[0].text, /父 Fork/);
    assert.equal(prompts[0].provider, "p");
    assert.equal((await readSnapshot(dir, fork.id)).events.length, 10, "snapshot untouched");

    // 从这个 Fork 启动的会话再存 Fork：命名请求里带上父 Fork 的名字和备注
    const { sessionId: childSession } = await lib.launch({ forkId: fork.id });
    services.sessionQuery.observeSession = async (id) => ({
      header: { id, cwd: "/tmp" },
      events: sampleEvents(),
      projections: { values: {} },
      [Symbol.dispose]() {},
    });
    const child = await lib.save({ sessionId: childSession, messageId: "m2" });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(child.fork.parentForkId, fork.id);
    assert.match(prompts.at(-1).messages.at(-1).content[0].text, /父 Fork：\n名称：示例问答\n备注：已回答两问。/);

    await lib.update({ forkId: fork.id, label: "手动" });
    await lib.autoName(fork.id, "s1", sampleEvents());
    assert.equal(lib.require(fork.id).label, "手动", "auto naming never overwrites a manual label");

    await lib.rename({ forkId: fork.id });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(lib.require(fork.id).label, "示例问答", "explicit AI rename overwrites");

    services.llm = { async *stream() { yield { type: "text-delta", text: "抱歉" }; } };
    const lib2 = new ForkLibrary(services, fakeTable(), dir);
    const r2 = await lib2.save({ sessionId: "s1" });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(lib2.require(r2.fork.id).naming, "failed");
    assert.equal(lib2.require(r2.fork.id).label, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("contextOf folds compaction replacements like the DSH surface", () => {
  const events = [
    { seq: 0, type: "system/message", surfaceOp: "append", data: { message: { role: "system", content: [{ type: "text", text: "sys" }] } } },
    { seq: 1, type: "request/header", data: { header: { config: { provider: "x", model: "y" }, tools: [{ name: "t" }] } } },
    { seq: 2, type: "user/message", surfaceOp: "append", data: { role: "user", content: [{ type: "text", text: "a" }] } },
    { seq: 3, type: "assistant/message", surfaceOp: "append", data: { message: { role: "assistant", content: [{ type: "text", text: "b" }] } } },
    { seq: 4, type: "assistant/message", surfaceOp: "append", data: { message: { role: "assistant", content: [] } } },
    { seq: 5, type: "user/message", surfaceOp: { op: "replace", startSeq: 2, endSeq: 3 }, data: { role: "user", content: [{ type: "text", text: "summary" }] } },
  ];
  const c = contextOf(events);
  assert.deepEqual(c.messages.map((m) => m.content[0]?.text), ["sys", "summary"]);
  assert.deepEqual(c.route, { provider: "x", model: "y" });
  assert.equal(c.tools.length, 1);
});

test("naming falls back to the default model when the recorded route fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fork-lib-"));
  try {
    const events = sampleEvents();
    events.splice(1, 0); // keep seqs
    events[0] = { seq: 0, type: "request/header", time: 0, data: { header: { config: { provider: "old", model: "gone" } } } };
    const { services } = fakeServices(new Map([["s1", events]]));
    const tried = [];
    services.llm = {
      async *stream(o) {
        tried.push(o.provider);
        if (o.provider === "old") throw new Error("unknown provider");
        yield { type: "text-delta", text: '{"name":"回退成功","note":""}' };
      },
    };
    const lib = new ForkLibrary(services, fakeTable(), dir);
    const { fork } = await lib.save({ sessionId: "s1" });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(tried, ["old", "p"]);
    assert.equal(lib.require(fork.id).label, "回退成功");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
