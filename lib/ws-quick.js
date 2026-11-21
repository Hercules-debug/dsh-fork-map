/**
 * 工作区快速新建（原 dsh-ws-quick，已并入 dsh-fork-map）。
 *
 * 官方「添加工作区」要走目录选择器逐层点，或手填完整路径。
 * 大部分时候只是想「在旁边再开一个」，所以这里把它变成一次点击：
 *   找到当前工作区 → 在它的上一级目录建短名目录 u-MMDD-N（和当前工作区并列）
 *   → 注册为工作区 → 客户端切过去
 *
 * 「当前工作区」= 正在看的会话所属的工作区。按钮由客户端传 workspaceId / sessionId，
 * `/ws` 命令取发出命令的会话。都找不到时退回列表里最新的工作区。
 * 新目录总在当前工作区的旁边，不会一层层往下嵌。
 *
 * 两个入口：
 *   - `/ws` 命令：`/ws`、`/ws 目录名`、`/ws 绝对路径`、`/ws --same`
 *   - 侧栏按钮：POST /ws-quick/new  { workspaceId?, sessionId? }
 *
 * 目录名刻意无含义：名字该由内容决定，而目录名一旦落到文件系统就不该承载语义。
 *
 * 作为 fork-map 的子插件挂载（见 index.js），有自己的 inject，
 * 所以 commands 等服务缺失时只影响这一块，不拖住 Fork 库。
 */
import { mkdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export const WS_ROUTE = "/ws-quick/new";

const DEFAULTS = { enabled: true, dirPrefix: "u" };

function describeError(error) {
  if (error === undefined || error === null) return "(none)";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message || error.name;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 生成形如 `u-1029-1` 的目录名（月日 + 序号），已存在就递增。
 * @param parent - 父目录。
 * @param prefix - 前缀。
 * @param now - 当前时间（可注入，便于测试）。
 */
export function nextDirName(parent, prefix = "u", now = new Date()) {
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  for (let i = 1; i < 1000; i += 1) {
    const candidate = `${prefix}-${mm}${dd}-${i}`;
    if (!isDirectory(join(parent, candidate))) return candidate;
  }
  throw new Error(`无法在 ${parent} 下找到可用的目录名`);
}

/**
 * 找「当前工作区」：优先按 workspaceId，其次找包含 sessionId 的工作区，
 * 都没有就取列表里第一个仍存在的（新建的排最前）。目录已不存在的跳过。
 * @param registry - workspaceRegistry。
 * @param hint - `{ workspaceId?, sessionId? }`。
 */
export function resolveCurrent(registry, hint = {}) {
  const alive = registry.list().filter((ws) => typeof ws?.path === "string" && ws.path && isDirectory(ws.path));
  const { workspaceId, sessionId } = hint;
  return (
    (workspaceId && alive.find((ws) => ws.id === workspaceId)) ||
    (sessionId && alive.find((ws) => Array.isArray(ws.sessionIds) && ws.sessionIds.includes(sessionId))) ||
    alive[0]
  );
}

/**
 * 新目录的父目录 = 当前工作区的上一级（新目录和当前工作区并列）。
 * 一个工作区都没有时用 process.cwd()。
 * @returns `{ base, current, from }`，current 是当前工作区路径（`--same` 用）。
 */
export function resolveBaseDir(registry, hint = {}) {
  const ws = resolveCurrent(registry, hint);
  if (ws) return { base: dirname(ws.path), current: ws.path, from: `与工作区「${ws.title || ws.path}」并列` };
  const cwd = resolve(process.cwd());
  return { base: cwd, current: cwd, from: "当前进程目录（没有可用工作区）" };
}

/** 把 `/ws` 的输入解析成目标目录。 */
export function resolveTarget(raw, base, prefix = "u", current = base) {
  const text = (raw || "").trim();
  if (!text) {
    const dirName = nextDirName(base, prefix);
    return { path: join(base, dirName), exists: false, mode: "auto", dirName };
  }
  if (text === "--same" || text === "same") {
    return { path: current, exists: true, mode: "same" };
  }
  if (isAbsolute(text) || text.startsWith("~")) {
    const expanded = text.startsWith("~") ? join(process.env.HOME || "", text.slice(1)) : text;
    const path = resolve(expanded);
    return { path, exists: isDirectory(path), mode: "absolute" };
  }
  const path = join(base, text);
  return { path, exists: isDirectory(path), mode: "relative", dirName: text };
}

/** 建目录（需要时）并注册为工作区。 */
export async function quickCreate(registry, raw, prefix = "u", hint = {}) {
  const { base, current, from } = resolveBaseDir(registry, hint);
  const target = resolveTarget(raw, base, prefix, current);
  if (!target.exists) {
    try {
      mkdirSync(target.path, { recursive: true });
    } catch (error) {
      throw new Error(`无法创建目录 ${target.path}：${describeError(error)}`);
    }
  }
  const title = target.dirName || target.path.split(sep).filter(Boolean).pop() || target.path;
  const workspace = await registry.create(target.path, title);
  return {
    workspace,
    base,
    from,
    path: target.path,
    title,
    created: !target.exists,
    reused: Boolean(target.exists) && target.mode === "same",
  };
}

/**
 * 读按钮发来的 `{ workspaceId?, sessionId? }`。只用来在 registry 里查找，
 * 不接受客户端给的路径；读不出来就当没有提示。
 * @param request - node IncomingMessage。
 */
async function readHint(request) {
  let text = "";
  try {
    for await (const chunk of request) {
      text += chunk;
      if (text.length > 4096) return {};
    }
    const parsed = text ? JSON.parse(text) : {};
    const pick = (v) => (typeof v === "string" && v.length > 0 && v.length <= 200 ? v : undefined);
    return { workspaceId: pick(parsed?.workspaceId), sessionId: pick(parsed?.sessionId) };
  } catch {
    return {};
  }
}

/** 子插件：注册 `/ws` 命令和按钮用的 HTTP 路由。 */
export const wsQuick = {
  name: "fork-map:ws-quick",
  inject: ["workspaceRegistry", "commands", "webServer"],
  apply(ctx, config = {}) {
    const options = { ...DEFAULTS, ...config };
    if (!options.enabled) return;

    ctx.commands.register({
      name: "ws",
      description: "快速新建工作区（建在当前工作区旁边）",
      input: { hint: "[目录名 | 绝对路径 | --same]" },
      handler: async ({ rawInput, agent }) => {
        try {
          const hint = { sessionId: agent?.session?.id };
          const result = await quickCreate(ctx.workspaceRegistry, rawInput, options.dirPrefix, hint);
          const lines = [
            result.reused ? `已切回工作区「${result.title}」` : `已创建工作区「${result.title}」`,
            `路径：${result.path}`,
          ];
          if (!result.reused) {
            lines.push(
              result.created
                ? `新建目录，${result.from}`
                : `目录已存在，直接注册（${result.from}）`,
            );
          }
          return { kind: "success", text: lines.join("\n") };
        } catch (error) {
          return { kind: "error", text: `新建工作区失败：${describeError(error)}` };
        }
      },
    });

    // 按钮的落点。建目录在 host 用 node:fs 做：remote.directoryPicker.createDirectory
    // 需要 browse 后端，macOS 本机 auto 选的是 native（只有 pick），会被拒。
    ctx.webServer.register({
      kind: "exact",
      path: WS_ROUTE,
      handler: async (request, response) => {
        const send = (status, payload) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(payload));
        };
        if (request.method !== "POST") return send(405, { ok: false, error: "method not allowed" });
        try {
          const hint = await readHint(request);
          const result = await quickCreate(ctx.workspaceRegistry, "", options.dirPrefix, hint);
          send(200, { ok: true, workspaceId: result.workspace?.id, path: result.path, title: result.title });
        } catch (error) {
          send(500, { ok: false, error: describeError(error) });
        }
      },
    });
  },
};
