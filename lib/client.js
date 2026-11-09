/**
 * dsh-fork-map client bundle — Fork 库界面。
 *
 * 格式：window.__ModuleLoader__.load({id, factory})，唯一外部依赖是 "react"，
 * 其余能力从注入的 cordis 服务拿（slots / sessions）。
 *
 * 界面：
 *   - conversation.chat.assistant-actions：每轮回复操作栏里的「存为 Fork」按钮
 *   - conversation.view「Fork 库」标签页：当前工作区的 Fork 图（按来源谱系成树），
 *     每个 Fork 可以反复「启动新会话」、改名、写备注、AI 起名、删除
 *
 * 数据走宿主端 /api/forkLibrary.*（DSH 的 /api 鉴权栅栏内，同源 fetch 自动带 cookie）。
 */
window.__ModuleLoader__.load({
  id: "dsh-fork-map",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const h = React.createElement;

    const VIEW_ID = "fork-library";
    const API = "/api/forkLibrary.";

    /** 运行时注入的 sessions 服务（apply 里绑定）。 */
    let sessions = null;
    /** 视图切换动作（Fork 库标签页挂载时捕获，供按钮跳转用）。 */
    const bridge = { openView: null };

    //#region api + shared store
    async function call(verb, payload) {
      const init = payload === undefined
        ? { headers: { accept: "application/json" } }
        : { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(payload) };
      const res = await fetch(API + verb, init);
      let data = null;
      try {
        data = await res.json();
      } catch {}
      if (!res.ok) throw new Error((data && data.error) || "HTTP " + res.status);
      return data;
    }

    /** 全局 Fork 列表缓存：按钮存完后通知标签页刷新。 */
    const store = {
      state: { loading: true, forks: [], error: null },
      listeners: new Set(),
      inflight: null,
      set(next) {
        this.state = Object.assign({}, this.state, next);
        for (const l of this.listeners) l();
      },
      subscribe(l) {
        store.listeners.add(l);
        return () => store.listeners.delete(l);
      },
      get() {
        return store.state;
      },
      refresh() {
        if (this.inflight) return this.inflight;
        this.inflight = call("list")
          .then((d) => this.set({ loading: false, forks: Array.isArray(d.forks) ? d.forks : [], error: null }))
          .catch((e) => this.set({ loading: false, error: String(e.message || e) }))
          .finally(() => {
            this.inflight = null;
          });
        return this.inflight;
      },
    };

    function useStore(src) {
      if (typeof React.useSyncExternalStore === "function") return React.useSyncExternalStore(src.subscribe, src.get, src.get);
      const [v, setV] = React.useState(src.get);
      React.useEffect(() => src.subscribe(() => setV(src.get())), [src]);
      return v;
    }

    const emptyList = { ids: [], byId: {} };
    function useSessionList() {
      const list = sessions && sessions.list;
      const sub = React.useCallback((l) => (list ? list.subscribe(l) : () => {}), [list]);
      const get = React.useCallback(() => (list ? list.getSnapshot() : emptyList), [list]);
      if (typeof React.useSyncExternalStore === "function") return React.useSyncExternalStore(sub, get, get);
      return get();
    }

    /** 新会话由宿主创建，浏览器列表要等 session-added 帧或刷新后才能 open。 */
    async function openSession(id) {
      if (!sessions) return false;
      for (let i = 0; i < 20; i++) {
        try {
          sessions.open(id);
          return true;
        } catch {}
        if (i === 0 || i % 5 === 4) {
          try {
            await sessions.refresh();
          } catch {}
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      return false;
    }
    //#endregion

    //#region helpers
    function normPath(p) {
      return typeof p === "string" ? p.replace(/\/+$/, "") : "";
    }
    function baseName(p) {
      const s = normPath(p);
      return s.slice(s.lastIndexOf("/") + 1) || s;
    }
    function ago(ms) {
      const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
      if (s < 60) return "刚刚";
      if (s < 3600) return Math.round(s / 60) + " 分钟前";
      if (s < 86400) return Math.round(s / 3600) + " 小时前";
      const d = Math.round(s / 86400);
      return d < 30 ? d + " 天前" : Math.round(d / 30) + " 个月前";
    }
    function fmtBytes(n) {
      if (!n) return "0";
      if (n >= 1048576) return (n / 1048576).toFixed(1) + "M";
      if (n >= 1024) return Math.round(n / 1024) + "K";
      return n + "B";
    }
    function forkName(f) {
      return f.label || f.source.title || f.summary.firstUser || "未命名 Fork";
    }
    /** 把一个工作区的 Fork 按 parentForkId 组织成森林。 */
    function buildForest(forks) {
      const ids = new Set(forks.map((f) => f.id));
      const children = new Map();
      const roots = [];
      for (const f of forks) {
        if (f.parentForkId && ids.has(f.parentForkId)) {
          if (!children.has(f.parentForkId)) children.set(f.parentForkId, []);
          children.get(f.parentForkId).push(f);
        } else roots.push(f);
      }
      const byTime = (a, b) => a.createdAt - b.createdAt;
      roots.sort(byTime);
      for (const list of children.values()) list.sort(byTime);
      return { roots, children };
    }
    //#endregion

    //#region 存为 Fork 按钮（每轮回复的操作栏）
    function SaveIcon() {
      return h(
        "svg",
        { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
        h("path", { d: "M4 2.5h8a.5.5 0 0 1 .5.5v10.6a.3.3 0 0 1-.48.24L8 11l-4.02 2.84a.3.3 0 0 1-.48-.24V3a.5.5 0 0 1 .5-.5z" }),
        h("path", { d: "M8 5v4M6 7h4" }),
      );
    }
    function DoneIcon() {
      return h(
        "svg",
        { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
        h("path", { d: "M3.5 8.5l3 3 6-7" }),
      );
    }

    function SaveForkAction(props) {
      const messageId = props.messageId;
      const sessionId = props.sessionId;
      const [state, setState] = React.useState({ phase: "idle", text: "" });
      const timer = React.useRef(null);
      React.useEffect(() => () => clearTimeout(timer.current), []);
      const flash = (phase, text) => {
        setState({ phase, text });
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setState({ phase: "idle", text: "" }), phase === "error" ? 4000 : 2200);
      };
      const onClick = () => {
        if (state.phase === "saving" || !sessionId) return;
        setState({ phase: "saving", text: "" });
        call("save", { sessionId, messageId })
          .then((d) => {
            flash("done", d.existed ? "这一轮已在 Fork 库中" : "已存入 Fork 库");
            void store.refresh();
          })
          .catch((e) => flash("error", String(e.message || e)));
      };
      const label = state.phase === "idle" ? "存为 Fork（保存到这一轮的上下文）" : state.text || "保存中…";
      return h(
        "span",
        { className: "fmk-act-wrap" },
        h(
          "button",
          {
            type: "button",
            className: "fmk-act",
            "data-phase": state.phase,
            "aria-label": "存为 Fork",
            title: label,
            disabled: state.phase === "saving",
            onClick,
          },
          state.phase === "done" ? h(DoneIcon) : h(SaveIcon),
        ),
        state.phase === "done" || state.phase === "error"
          ? h("span", { className: "fmk-act-note", "data-phase": state.phase }, state.text)
          : null,
      );
    }
    //#endregion

    //#region Fork 卡片
    function ForkCard({ fork, listById, onChanged }) {
      const [busy, setBusy] = React.useState("");
      const [err, setErr] = React.useState("");
      const [editing, setEditing] = React.useState(null);
      const [draft, setDraft] = React.useState("");

      const run = (key, fn) => {
        if (busy) return;
        setBusy(key);
        setErr("");
        Promise.resolve()
          .then(fn)
          .catch((e) => setErr(String(e.message || e)))
          .finally(() => setBusy(""));
      };
      const launch = () =>
        run("launch", async () => {
          const d = await call("launch", { forkId: fork.id });
          onChanged();
          const opened = await openSession(d.sessionId);
          if (!opened) setErr("新会话已创建，但列表还没刷新出来，请在侧栏中查找");
        });
      const autoname = () =>
        run("autoname", async () => {
          await call("autoname", { forkId: fork.id });
          onChanged();
        });
      const remove = () => {
        if (!window.confirm("删除 Fork「" + forkName(fork) + "」？\n快照会被删除，已经启动的会话不受影响。")) return;
        run("delete", async () => {
          await call("delete", { forkId: fork.id });
          onChanged();
        });
      };
      const beginEdit = (field) => {
        setEditing(field);
        setDraft(field === "label" ? fork.label || forkName(fork) : fork.note || "");
      };
      const commitEdit = () => {
        const field = editing;
        setEditing(null);
        run("edit", async () => {
          await call("update", { forkId: fork.id, [field]: draft });
          onChanged();
        });
      };
      const sourceAlive = listById[fork.source.sessionId] !== undefined;
      const naming = fork.naming === "pending";
      const s = fork.summary || {};

      return h(
        "div",
        { className: "fmk-card" },
        h(
          "div",
          { className: "fmk-head" },
          editing === "label"
            ? h("input", {
                className: "fmk-input",
                autoFocus: true,
                value: draft,
                maxLength: 80,
                onChange: (e) => setDraft(e.target.value),
                onBlur: commitEdit,
                onKeyDown: (e) => {
                  if (e.key === "Enter") commitEdit();
                  if (e.key === "Escape") setEditing(null);
                },
              })
            : h("span", { className: "fmk-name", title: "双击改名", onDoubleClick: () => beginEdit("label") }, naming && !fork.label ? "正在起名…" : forkName(fork)),
          h("span", { className: "fmk-chip" }, s.turns + " 轮"),
          h("span", { className: "fmk-time", title: new Date(fork.createdAt).toLocaleString() }, ago(fork.createdAt)),
        ),
        s.lastUser ? h("div", { className: "fmk-line" }, h("b", null, "最后提问 "), s.lastUser) : null,
        s.lastAssistant ? h("div", { className: "fmk-line fmk-dim" }, h("b", null, "最后回复 "), s.lastAssistant) : null,
        editing === "note"
          ? h("textarea", {
              className: "fmk-input fmk-note-input",
              autoFocus: true,
              value: draft,
              maxLength: 2000,
              rows: 3,
              onChange: (e) => setDraft(e.target.value),
              onBlur: commitEdit,
              onKeyDown: (e) => {
                if (e.key === "Escape") setEditing(null);
              },
            })
          : fork.note
            ? h("div", { className: "fmk-note", onDoubleClick: () => beginEdit("note") }, fork.note)
            : null,
        h(
          "div",
          { className: "fmk-meta" },
          "来源：",
          sourceAlive
            ? h("a", { className: "fmk-link", onClick: () => void openSession(fork.source.sessionId) }, fork.source.title || fork.source.sessionId.slice(8, 16))
            : h("span", { className: "fmk-gone", title: "源会话已删除，Fork 快照仍可用" }, (fork.source.title || "源会话") + "（已删除）"),
          " · 快照 " + fmtBytes(fork.bytes),
        ),
        h(
          "div",
          { className: "fmk-actions" },
          h("button", { type: "button", className: "fmk-btn fmk-primary", disabled: !!busy, onClick: launch }, busy === "launch" ? "启动中…" : "从这里启动新会话"),
          h("button", { type: "button", className: "fmk-btn", disabled: !!busy, onClick: () => beginEdit("label") }, "改名"),
          h(
            "button",
            { type: "button", className: "fmk-btn", disabled: !!busy || naming, title: "让模型重新生成名字和备注（会覆盖现有的）", onClick: autoname },
            naming ? "生成中…" : "AI 起名",
          ),
          h("button", { type: "button", className: "fmk-btn", disabled: !!busy, onClick: () => beginEdit("note") }, fork.note ? "改备注" : "备注"),
          h("button", { type: "button", className: "fmk-btn fmk-danger", disabled: !!busy, onClick: remove }, "删除"),
        ),
        err ? h("div", { className: "fmk-err" }, err) : null,
      );
    }
    //#endregion

    //#region Fork 库标签页（Fork 图）
    function ForkTree({ forks, children, listById, onChanged, depth }) {
      return h(
        "ul",
        { className: depth === 0 ? "fmk-tree" : "fmk-tree fmk-sub" },
        forks.map((f) =>
          h(
            "li",
            { key: f.id, className: "fmk-node" },
            h(ForkCard, { fork: f, listById, onChanged }),
            children.has(f.id)
              ? h(ForkTree, { forks: children.get(f.id), children, listById, onChanged, depth: depth + 1 })
              : null,
          ),
        ),
      );
    }

    function ForkLibraryView(props) {
      if (props.openView) bridge.openView = props.openView;
      const state = useStore(store);
      const list = useSessionList();
      const listById = (list && list.byId) || {};
      const currentCwd = normPath((listById[props.sessionId] || {}).cwd);
      const [scope, setScope] = React.useState("current");

      React.useEffect(() => {
        void store.refresh();
        const t = setInterval(() => void store.refresh(), 15000);
        return () => clearInterval(t);
      }, []);

      const anyNaming = state.forks.some((f) => f.naming === "pending");
      React.useEffect(() => {
        if (!anyNaming) return;
        const t = setInterval(() => void store.refresh(), 2000);
        return () => clearInterval(t);
      }, [anyNaming]);

      const groups = React.useMemo(() => {
        const map = new Map();
        for (const f of state.forks) {
          const key = normPath(f.cwd);
          if (scope === "current" && currentCwd !== "" && key !== currentCwd) continue;
          if (!map.has(key)) map.set(key, []);
          map.get(key).push(f);
        }
        return [...map.entries()].sort((a, b) => (a[0] === currentCwd ? -1 : b[0] === currentCwd ? 1 : a[0].localeCompare(b[0])));
      }, [state.forks, scope, currentCwd]);

      const onChanged = () => void store.refresh();
      const total = state.forks.length;

      return h(
        "div",
        { className: "fmk-root" },
        h(
          "div",
          { className: "fmk-toolbar" },
          h("span", { className: "fmk-title" }, "Fork 库"),
          h("span", { className: "fmk-dim" }, scope === "current" ? (currentCwd ? baseName(currentCwd) : "当前工作区") : "全部工作区 · " + total + " 个 Fork"),
          h("span", { className: "fmk-spacer" }),
          h(
            "div",
            { className: "fmk-seg" },
            h("button", { type: "button", "data-on": scope === "current" || undefined, onClick: () => setScope("current") }, "当前工作区"),
            h("button", { type: "button", "data-on": scope === "all" || undefined, onClick: () => setScope("all") }, "全部"),
          ),
          h("button", { type: "button", className: "fmk-btn", onClick: onChanged }, "刷新"),
        ),
        state.error ? h("div", { className: "fmk-err fmk-pad" }, "读取 Fork 库失败：" + state.error) : null,
        state.loading
          ? h("div", { className: "fmk-empty" }, "加载中…")
          : groups.length === 0
            ? h(
                "div",
                { className: "fmk-empty" },
                h("div", null, "这个工作区还没有 Fork。"),
                h("div", { className: "fmk-dim" }, "在任意一轮回复下方的操作栏点书签图标「存为 Fork」，就会把到这一轮为止的上下文存进来。"),
                h("div", { className: "fmk-dim" }, "名字和备注会由模型自动生成。之后随时从 Fork 启动新会话，可以反复启动；源会话删了也不影响。"),
              )
            : groups.map(([cwd, forks]) => {
                const forest = buildForest(forks);
                return h(
                  "section",
                  { key: cwd, className: "fmk-ws" },
                  h("div", { className: "fmk-ws-head", title: cwd }, h("span", null, baseName(cwd)), h("span", { className: "fmk-dim" }, cwd + " · " + forks.length + " 个 Fork")),
                  h(ForkTree, { forks: forest.roots, children: forest.children, listById, onChanged, depth: 0 }),
                );
              }),
      );
    }
    //#endregion

    //#region styles
    const CSS = `
.fmk-act-wrap{display:inline-flex;align-items:center}
.fmk-act{width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));display:inline-flex;align-items:center;justify-content:center;padding:6px;border:none;border-radius:28px;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.fmk-act svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px))}
.fmk-act:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.fmk-act:disabled{opacity:.5;cursor:default}
.fmk-act[data-phase=done]{color:var(--dsw-alias-state-success-primary)}
.fmk-act[data-phase=error]{color:var(--dsw-alias-state-error-primary)}
.fmk-act-note{font-size:12px;color:var(--dsw-alias-label-tertiary);padding:0 6px;white-space:nowrap;max-width:320px;overflow:hidden;text-overflow:ellipsis}
.fmk-act-note[data-phase=error]{color:var(--dsw-alias-state-error-primary)}
.fmk-root{height:100%;overflow:auto;padding:16px 24px 48px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;box-sizing:border-box}
.fmk-toolbar{display:flex;align-items:center;gap:10px;margin:0 0 14px;position:sticky;top:-16px;padding:8px 0;background:var(--dsw-alias-bg-base);z-index:1}
.fmk-title{font-weight:600;font-size:15px}
.fmk-spacer{flex:1}
.fmk-dim{color:var(--dsw-alias-label-tertiary)}
.fmk-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden}
.fmk-seg button{border:none;background:0 0;color:var(--dsw-alias-label-secondary);padding:3px 10px;font:inherit;cursor:pointer}
.fmk-seg button[data-on]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.fmk-btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);border-radius:8px;padding:3px 10px;font:inherit;font-size:12px;cursor:pointer}
.fmk-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.fmk-btn:disabled{opacity:.5;cursor:default}
.fmk-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.fmk-danger:hover{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger)}
.fmk-ws{margin:0 0 22px}
.fmk-ws-head{display:flex;gap:10px;align-items:baseline;font-weight:600;margin:0 0 8px}
.fmk-ws-head .fmk-dim{font-weight:400;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fmk-tree{list-style:none;margin:0;padding:0}
.fmk-sub{margin-left:18px;padding-left:16px;border-left:1px dashed var(--dsw-alias-border-l3)}
.fmk-node{margin:0 0 10px;position:relative}
.fmk-sub>.fmk-node::before{content:"";position:absolute;left:-16px;top:22px;width:14px;border-top:1px dashed var(--dsw-alias-border-l3)}
.fmk-card{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px;max-width:760px}
.fmk-card:hover{border-color:var(--dsw-alias-border-l4)}
.fmk-head{display:flex;align-items:center;gap:8px;margin:0 0 4px}
.fmk-name{font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:text}
.fmk-chip{font-size:11px;border-radius:6px;padding:0 6px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.fmk-time{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.fmk-line{overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;margin:2px 0}
.fmk-line b{font-weight:500;color:var(--dsw-alias-label-tertiary)}
.fmk-note{margin:6px 0 2px;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);white-space:pre-wrap;cursor:text}
.fmk-meta{font-size:12px;color:var(--dsw-alias-label-tertiary);margin:6px 0 0}
.fmk-link{color:var(--dsw-alias-link,var(--dsw-alias-brand-primary));cursor:pointer;text-decoration:none}
.fmk-link:hover{text-decoration:underline}
.fmk-gone{color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-tertiary));text-decoration:line-through}
.fmk-actions{display:flex;gap:6px;margin:8px 0 0;flex-wrap:wrap}
.fmk-input{width:100%;box-sizing:border-box;font:inherit;color:inherit;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l3);border-radius:6px;padding:2px 6px}
.fmk-note-input{margin:6px 0 0;resize:vertical}
.fmk-err{color:var(--dsw-alias-state-error-primary);font-size:12px;margin:6px 0 0}
.fmk-pad{margin:0 0 12px}
.fmk-empty{padding:48px 0;text-align:center;display:flex;flex-direction:column;gap:6px}
`;
    function injectCss() {
      if (typeof document === "undefined") return () => {};
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-fork-map";
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => tag.remove();
    }
    //#endregion

    exports.name = "fork-map";
    exports.inject = ["slots", "sessions"];
    exports.apply = function apply(ctx) {
      sessions = ctx.sessions;
      const slots = ctx.slots;
      if (slots === undefined) return;
      ctx.effect(injectCss, "dsh-fork-map: css");

      slots.inject("conversation.chat.assistant-actions", () =>
        slots.register({ name: "conversation.chat.assistant-actions", id: "fork-map-save", order: 20, label: () => "存为 Fork" }, SaveForkAction),
      );
      slots.inject("conversation.view", () =>
        slots.register({ name: "conversation.view", id: VIEW_ID, order: 40, label: () => "Fork 库" }, ForkLibraryView),
      );
    };

    return module.exports;
  },
});
