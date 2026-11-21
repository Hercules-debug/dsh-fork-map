import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as mod from "../lib/ws-quick.js";
import * as entry from "../lib/index.js";

function mkRegistry(initial = []) {
  const state = [...initial];
  return {
    list: () => state,
    create: async (path, title) => {
      const w = { id: `ws-${state.length}`, path, title };
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

test("无参数时在父工作区下建 u-MMDD-N 子目录", async () => {
  const base = mkBase();
  const r = await mod.quickCreate(mkRegistry([{ id: "a", path: base, title: "父" }]), "");
  assert.equal(r.created, true);
  assert.ok(existsSync(r.path));
  assert.ok(r.path.startsWith(base));
  assert.match(r.title, /^u-\d{4}-\d+$/u);
});

test("重复点击递增序号，不覆盖已有目录", async () => {
  const base = mkBase();
  const reg = mkRegistry([{ id: "a", path: base, title: "父" }]);
  const first = await mod.quickCreate(reg, "");
  // 第一次创建的工作区排到列表头，第二次会建在它下面
  const second = await mod.quickCreate(reg, "");
  assert.notEqual(first.path, second.path);
  assert.ok(existsSync(first.path) && existsSync(second.path));
});

test("相对名作为子目录名", async () => {
  const base = mkBase();
  const r = await mod.quickCreate(mkRegistry([{ id: "a", path: base, title: "父" }]), "my-task");
  assert.equal(r.title, "my-task");
  assert.equal(r.path, join(base, "my-task"));
});

test("--same 复用父目录", async () => {
  const base = mkBase();
  const r = await mod.quickCreate(mkRegistry([{ id: "a", path: base, title: "父" }]), "--same");
  assert.equal(r.reused, true);
  assert.equal(r.path, base);
});

test("绝对路径直接采用，已存在不算新建", async () => {
  const other = mkBase();
  const r = await mod.quickCreate(mkRegistry([{ id: "a", path: mkBase(), title: "父" }]), other);
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

test("路由成功时返回 workspaceId 与路径", async () => {
  const { routes } = mkApply({ registry: mkRegistry([{ id: "a", path: mkBase(), title: "父" }]) });
  const res = mkResponse();
  await routes[0].handler({ method: "POST" }, res);
  const data = JSON.parse(res.body);
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.ok(data.path);
  assert.ok("workspaceId" in data);
});

test("路由创建失败时返回 500 与错误文本", async () => {
  const { routes } = mkApply({
    registry: { list: () => [{ id: "a", path: mkBase() }], create: async () => { throw new Error("disk full"); } },
  });
  const res = mkResponse();
  await routes[0].handler({ method: "POST" }, res);
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
  const deps = [...artifact.matchAll(/\brequire\("([^"]+)"\)/gu)].map((m) => m[1]);
  assert.deepEqual([...new Set(deps)], ["react"]);
});
