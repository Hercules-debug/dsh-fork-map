import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import * as mod from "../lib/ws-quick.js";
import * as entry from "../lib/index.js";

function mkRegistry(initial = []) {
  const state = [...initial];
  return {
    list: () => state,
    create: async (path, title) => {
      const w = { id: `ws-${state.length}`, path, title, sessionIds: [] };
      state.unshift(w);
      return w;
    },
  };
}

/** 用假的宿主服务 apply 子插件，收集命令和路由。 */
/** 最小的 node http response 假对象。 */
function mkResponse() {
  return {
    status: 0,
    body: "",
    writeHead(code) { this.status = code; },
    end(chunk) { this.body = chunk; },
  };
}

function mkApply({ registry = mkRegistry([]), config = { enabled: true } } = {}) {
  const commands = [];
  const routes = [];
  const ctx = {
    workspaceRegistry: registry,
    commands: { register: (d) => commands.push(d) },
    webServer: { register: (r) => routes.push(r) },
  };
  mod.wsQuick.apply(ctx, config);
  return { commands, routes };
}

const mkBase = () => mkdtempSync(join(tmpdir(), "wsq-"));
/** 在一个临时根目录下建一个「当前工作区」目录。 */
function mkWorkspaceDir(name = "proj") {
  const root = mkBase();
  const path = join(root, name);
  mkdirSync(path);
  return { root, path };
}
/** 带 JSON body 的假 POST 请求（可 for-await 读取）。 */
function mkPost(payload) {
  const req = Readable.from(payload === undefined ? [] : [JSON.stringify(payload)]);
  req.method = "POST";
  return req;
}

test("无参数时建在当前工作区旁边（同一个上级目录）", async () => {
  const { root, path } = mkWorkspaceDir();
  const r = await mod.quickCreate(mkRegistry([{ id: "a", path, title: "proj" }]), "");
  assert.equal(r.created, true);
  assert.ok(existsSync(r.path));
  assert.equal(dirname(r.path), root);
  assert.match(r.title, /^u-\d{4}-\d+$/u);
});

test("连续点击不会往下嵌套，都和当前工作区并列", async () => {
  const { root, path } = mkWorkspaceDir();
  const reg = mkRegistry([{ id: "a", path, title: "proj" }]);
  const first = await mod.quickCreate(reg, "", "u", { workspaceId: "a" });
  const second = await mod.quickCreate(reg, "", "u", { workspaceId: "a" });
  assert.notEqual(first.path, second.path);
  assert.equal(dirname(first.path), root);
  assert.equal(dirname(second.path), root);
});

test("没有提示时，以最新的工作区为当前，仍是并列而不是嵌套", async () => {
  const { root, path } = mkWorkspaceDir();
  const reg = mkRegistry([{ id: "a", path, title: "proj" }]);
  const first = await mod.quickCreate(reg, "");
  const second = await mod.quickCreate(reg, "");
  assert.equal(dirname(first.path), root);
  assert.equal(dirname(second.path), root, "第二次以第一次新建的为当前，它们同级");
});

test("按 workspaceId 选当前工作区，而不是列表里最新的", async () => {
  const a = mkWorkspaceDir("a");
  const b = mkWorkspaceDir("b");
  const reg = mkRegistry([
    { id: "new", path: a.path, title: "a" },
    { id: "old", path: b.path, title: "b" },
  ]);
  const r = await mod.quickCreate(reg, "", "u", { workspaceId: "old" });
  assert.equal(dirname(r.path), b.root);
});

test("按 sessionId 找到所属工作区", async () => {
  const a = mkWorkspaceDir("a");
  const b = mkWorkspaceDir("b");
  const reg = mkRegistry([
    { id: "new", path: a.path, title: "a", sessionIds: [] },
    { id: "old", path: b.path, title: "b", sessionIds: ["s1"] },
  ]);
  const r = await mod.quickCreate(reg, "", "u", { sessionId: "s1" });
  assert.equal(dirname(r.path), b.root);
});

test("当前工作区目录已不存在时跳过它", async () => {
  const a = mkWorkspaceDir("a");
  const reg = mkRegistry([
    { id: "gone", path: join(a.root, "deleted"), title: "gone" },
    { id: "a", path: a.path, title: "a" },
  ]);
  const r = await mod.quickCreate(reg, "", "u", { workspaceId: "gone" });
  assert.equal(dirname(r.path), a.root);
});

test("相对名建在当前工作区旁边", async () => {
  const { root, path } = mkWorkspaceDir();
  const r = await mod.quickCreate(mkRegistry([{ id: "a", path, title: "proj" }]), "my-task");
  assert.equal(r.title, "my-task");
  assert.equal(r.path, join(root, "my-task"));
});

test("--same 复用当前工作区本身", async () => {
  const { path } = mkWorkspaceDir();
  const r = await mod.quickCreate(mkRegistry([{ id: "a", path, title: "proj" }]), "--same");
  assert.equal(r.reused, true);
  assert.equal(r.path, path);
});

test("绝对路径直接采用，已存在不算新建", async () => {
  const other = mkBase();
  const r = await mod.quickCreate(mkRegistry([{ id: "a", path: mkWorkspaceDir().path, title: "p" }]), other);
  assert.equal(r.path, other);
  assert.equal(r.created, false);
});

test("没有工作区时回退到进程目录", () => {
  assert.match(mod.resolveBaseDir(mkRegistry([])).from, /没有可用工作区/u);
});

test("目录名碰撞时递增", () => {
  const base = mkBase();
  mkdirSync(join(base, "u-1029-1"));
  mkdirSync(join(base, "u-1029-2"));
  assert.equal(mod.nextDirName(base, "u", new Date(2026, 9, 29)), "u-1029-3");
});

test("注册 /ws 命令和 /ws-quick/new 路由", () => {
  const { commands, routes } = mkApply();
  assert.deepEqual(commands.map((c) => c.name), ["ws"]);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, "/ws-quick/new");
  assert.equal(routes[0].kind, "exact");
});

test("路由拒绝非 POST", async () => {
  const { routes } = mkApply();
  const res = mkResponse();
  await routes[0].handler({ method: "GET" }, res);
  assert.equal(res.status, 405);
  assert.equal(JSON.parse(res.body).ok, false);
});

test("enabled=false 时什么都不注册", () => {
  const { commands, routes } = mkApply({ config: { enabled: false } });
  assert.equal(commands.length + routes.length, 0);
});

test("命令失败时返回 error 而不是抛异常", async () => {
  const { commands } = mkApply({
    registry: { list: () => [{ id: "a", path: mkBase() }], create: async () => { throw new Error("boom"); } },
  });
  const out = await commands[0].handler({ rawInput: "x" });
  assert.equal(out.kind, "error");
  assert.match(out.text, /boom/u);
});

test("路由按 body 里的 workspaceId 建在该工作区旁边", async () => {
  const a = mkWorkspaceDir("a");
  const b = mkWorkspaceDir("b");
  const { routes } = mkApply({
    registry: mkRegistry([
      { id: "new", path: a.path, title: "a" },
      { id: "old", path: b.path, title: "b" },
    ]),
  });
  const res = mkResponse();
  await routes[0].handler(mkPost({ workspaceId: "old" }), res);
  const data = JSON.parse(res.body);
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(dirname(data.path), b.root);
  assert.ok("workspaceId" in data);
});

test("路由 body 不是 JSON 时退回最新工作区", async () => {
  const a = mkWorkspaceDir("a");
  const { routes } = mkApply({ registry: mkRegistry([{ id: "a", path: a.path, title: "a" }]) });
  const req = Readable.from(["not json"]);
  req.method = "POST";
  const res = mkResponse();
  await routes[0].handler(req, res);
  assert.equal(res.status, 200);
  assert.equal(dirname(JSON.parse(res.body).path), a.root);
});

test("/ws 命令以发出命令的会话所在工作区为当前", async () => {
  const a = mkWorkspaceDir("a");
  const b = mkWorkspaceDir("b");
  const { commands } = mkApply({
    registry: mkRegistry([
      { id: "new", path: a.path, title: "a", sessionIds: [] },
      { id: "old", path: b.path, title: "b", sessionIds: ["s1"] },
    ]),
  });
  const out = await commands[0].handler({ rawInput: "", agent: { session: { id: "s1" } } });
  assert.equal(out.kind, "success");
  assert.ok(out.text.includes(b.root), out.text);
});

test("路由创建失败时返回 500 与错误文本", async () => {
  const { routes } = mkApply({
    registry: { list: () => [{ id: "a", path: mkBase() }], create: async () => { throw new Error("disk full"); } },
  });
  const res = mkResponse();
  await routes[0].handler(mkPost({}), res);
  assert.equal(res.status, 500);
  assert.match(JSON.parse(res.body).error, /disk full/u);
});

test("fork-map 入口把 ws-quick 作为子插件挂上，并透传 wsQuick 配置", () => {
  const mounted = [];
  const ctx = {
    plugin: (plugin, config) => mounted.push({ plugin, config }),
    effect: () => {},
    connection: { fetch: { register: () => {} } },
  };
  entry.apply(ctx, { wsQuick: { dirPrefix: "w" } });
  assert.equal(mounted.length, 1);
  assert.equal(mounted[0].plugin, mod.wsQuick);
  assert.deepEqual(mounted[0].config, { dirPrefix: "w" });
});

test("client 产物把按钮挂到 sidebar.footer.action，且只依赖 react", () => {
  const artifact = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.match(artifact, /name: "sidebar\.footer\.action", id: "ws-quick", locale: WSQ_NS/u);
  assert.match(artifact, /fetch\("\/ws-quick\/new"/u);
  assert.match(artifact, /body: JSON\.stringify\(currentWorkspaceHint\(ctx\)\)/u);
  const deps = [...artifact.matchAll(/\brequire\("([^"]+)"\)/gu)].map((m) => m[1]);
  assert.deepEqual([...new Set(deps)], ["react"]);
});
