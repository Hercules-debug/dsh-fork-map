/**
 * dsh-fork-map — host half：每个工作区一个持久化的 Fork 库。
 *
 * DSH 原生「分叉」点一下就立刻变成一个新会话，分叉点本身不留存。
 * 这里把分叉点做成独立资源：
 *   save   —— 把某个会话在某一轮结束时的完整上下文存成快照（Fork）
 *   launch —— 任何时候从 Fork 启动一个新会话，可以反复启动
 * 快照与源会话无关：源会话删掉，Fork 仍然可以启动。
 *
 * 路由（都在 DSH 的 /api 鉴权栅栏内，浏览器同源 fetch 自动带 cookie）：
 *   GET  /api/forkLibrary.list
 *   POST /api/forkLibrary.save    { sessionId, messageId?, atSeq?, label? }
 *   POST /api/forkLibrary.launch  { forkId }
 *   POST /api/forkLibrary.update  { forkId, label?, note? }
 *   POST /api/forkLibrary.delete  { forkId }
 *   POST /api/forkLibrary.autoname { forkId }   用模型重新起名、写备注
 *
 * 新会话的创建路径与原生 fork 相同（session-controller 的 fork 方法）：
 * 同样的 seed/inheritedEventCount、同样的 preset 组装、同样由 session
 * controller 持有生命周期、同样挂进工作区。区别只是 seed 来自快照文件，
 * 且不写 parentSession（Fork 才是来源，源会话可能已不存在）。
 */
import { ForkLibrary, HttpError, body, json, passthroughSchema } from "./library.js";
import { snapshotDir } from "./store.js";

export const name = "fork-map";
export const inject = [
  "connection",
  "storageDomain",
  "sessionQuery",
  "sessions",
  "agents",
  "agentDefaultModel",
  "workspaceRegistry",
  "sessionController",
];

const TAG = "[dsh-fork-map]";
const DOMAIN = "fork_library";
const ROUTE = "/api/forkLibrary.";

/* ---------------- plugin entry ---------------- */

export function apply(ctx) {
  let resolveLib;
  let rejectLib;
  const ready = new Promise((resolve, reject) => {
    resolveLib = resolve;
    rejectLib = reject;
  });
  ready.catch(() => {});

  ctx.effect(() => {
    let disposed = false;
    let domain;
    ctx.storageDomain
      .open({
        name: DOMAIN,
        version: 1,
        tables: { forks: { valueSchema: passthroughSchema() } },
      })
      .then((opened) => {
        if (disposed) {
          void opened.close();
          return;
        }
        domain = opened;
        const services = {
          ctx,
          logger: ctx.logger,
          sessionQuery: ctx.sessionQuery,
          sessions: ctx.sessions,
          agents: ctx.agents,
          agentDefaultModel: ctx.agentDefaultModel,
          workspaceRegistry: ctx.workspaceRegistry,
          sessionController: ctx.sessionController,
          get llm() {
            return ctx.get("llm");
          },
        };
        const forks = opened.table("forks");
        // 上次进程退出时还没起完名的，标为失败，避免界面一直显示「正在起名」
        for (const [key, rec] of forks.entries()) {
          if (rec?.naming === "pending") void forks.update(key, (cur) => ({ ...cur, naming: "failed" }));
        }
        resolveLib(new ForkLibrary(services, forks, snapshotDir()));
        ctx.logger?.info?.(`${TAG} ready, routes at ${ROUTE}*`);
      })
      .catch((error) => {
        ctx.logger?.warn?.(`${TAG} storage domain failed: ${String(error)}`);
        rejectLib(error);
      });
    return () => {
      disposed = true;
      void domain?.close();
    };
  }, "dsh-fork-map: storage domain");

  const routes = {
    list: { method: "GET", run: (lib) => ({ forks: lib.list() }) },
    save: { method: "POST", run: (lib, b) => lib.save(b) },
    launch: { method: "POST", run: (lib, b) => lib.launch(b) },
    update: { method: "POST", run: (lib, b) => lib.update(b) },
    delete: { method: "POST", run: (lib, b) => lib.remove(b) },
    autoname: { method: "POST", run: (lib, b) => lib.rename(b) },
  };

  for (const [verb, route] of Object.entries(routes)) {
    ctx.connection.fetch.register({
      path: ROUTE + verb,
      methods: [route.method],
      requestBody: "buffered",
      fetch: async (request) => {
        try {
          const lib = await ready;
          const payload = route.method === "POST" ? await body(request) : {};
          return json(200, await route.run(lib, payload));
        } catch (error) {
          const status = error instanceof HttpError ? error.status : 500;
          if (status === 500) ctx.logger?.warn?.(`${TAG} ${verb} failed: ${String(error?.stack ?? error)}`);
          return json(status, { error: String(error?.message ?? error) });
        }
      },
    });
  }
}
