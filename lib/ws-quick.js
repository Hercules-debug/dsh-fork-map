/**
 * 工作区快速新建（原 dsh-ws-quick，已并入 dsh-fork-map）。
 *
 * 官方「添加工作区」要走目录选择器逐层点，或手填完整路径。
 * 大部分时候只是想「在刚才那个地方再开一个」，所以这里把它变成一次点击：
 *   取最近的工作区为父目录 → 建短名子目录 u-MMDD-N → 注册为工作区 → 客户端切过去
 *
 * 两个入口：
 *   - `/ws` 命令：`/ws`、`/ws 子目录名`、`/ws 绝对路径`、`/ws --same`
 *   - 侧栏按钮：POST /ws-quick/new
 *
 * 目录名刻意无含义：名字该由内容决定，而目录名一旦落到文件系统就不该承载语义。
 *
 * 作为 fork-map 的子插件挂载（见 index.js），有自己的 inject，
 * 所以 commands 等服务缺失时只影响这一块，不拖住 Fork 库。
 */
import { mkdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

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
 * 父目录 = registry 列表里第一个仍存在的工作区（新建的排最前）。
 * 一个都没有时退回 process.cwd()。
 */
export function resolveBaseDir(registry) {
  for (const ws of registry.list()) {
    const path = ws?.path;
    if (typeof path === "string" && path && isDirectory(path)) {
      return { base: path, from: `工作区「${ws.title || path}」` };
    }
  }
  return { base: resolve(process.cwd()), from: "当前进程目录（没有可用工作区）" };
}

/** 把 `/ws` 的输入解析成目标目录。 */
export function resolveTarget(raw, base, prefix = "u") {
  const text = (raw || "").trim();
  if (!text) {
    const dirName = nextDirName(base, prefix);
    return { path: join(base, dirName), exists: false, mode: "auto", dirName };
  }
  if (text === "--same" || text === "same") {
    return { path: base, exists: true, mode: "same" };
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
export async function quickCreate(registry, raw, prefix = "u") {
  const { base, from } = resolveBaseDir(registry);
  const target = resolveTarget(raw, base, prefix);
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

/** 子插件：注册 `/ws` 命令和按钮用的 HTTP 路由。 */
export const wsQuick = {
  name: "fork-map:ws-quick",
  inject: ["workspaceRegistry", "commands", "webServer"],
  apply(ctx, config = {}) {
    const options = { ...DEFAULTS, ...config };
    if (!options.enabled) return;

    ctx.commands.register({
      name: "ws",
      description: "快速新建工作区（默认在上一个工作区下建子目录）",
      input: { hint: "[子目录名 | 绝对路径 | --same]" },
      handler: async ({ rawInput }) => {
        try {
          const result = await quickCreate(ctx.workspaceRegistry, rawInput, options.dirPrefix);
          const lines = [
            result.reused ? `已切回工作区「${result.title}」` : `已创建工作区「${result.title}」`,
            `路径：${result.path}`,
          ];
          if (!result.reused) {
            lines.push(
              result.created
                ? `新建目录，父目录来自${result.from}`
                : `目录已存在，直接注册（父目录来自${result.from}）`,
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
          const result = await quickCreate(ctx.workspaceRegistry, "", options.dirPrefix);
          send(200, { ok: true, workspaceId: result.workspace?.id, path: result.path, title: result.title });
        } catch (error) {
          send(500, { ok: false, error: describeError(error) });
        }
      },
    });
  },
};
