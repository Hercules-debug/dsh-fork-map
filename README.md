# dsh-fork-map：Fork 库

每个工作区一个持久化的 Fork 库。Fork 是某个会话到某一轮结束时的完整上下文快照，可以反复从它启动新会话；源会话删掉后 Fork 仍可用。

## 用法

- 存：在任意一轮回复下方的操作栏点书签图标「存为 Fork」。同一轮重复点只存一份。
- 看：对话区顶部切到「Fork 库」标签。默认只显示当前工作区，可切到「全部」。从某个 Fork 启动出来的会话再存的 Fork，会挂在原 Fork 下面，形成 Fork 图。
- 用：卡片上点「从这里启动新会话」，每次都新建一个独立会话，标题为 `<名称> · Fork N`。卡片也支持改名（或双击名称）、备注和删除。

## 存储

- 索引：DSH storage domain `fork_library`，文件是 `~/.dsh/storages/fork_library.json`。
- 快照：`~/.dsh/storages/fork_library_snapshots/<forkId>.json.zst`，内容是事件前缀 `seq 0..cut-1`。
- 切点规则与原生分叉相同：锚点之后第一个 `turn/end`，再推进到下一个 `turn/start` 之前。

## 实现

- `lib/index.js`：宿主插件入口，注册 `/api/forkLibrary.{list,save,launch,update,delete}`。这些路由在 DSH 的 `/api` 鉴权范围内。
- `lib/library.js`：保存、启动、编辑、删除逻辑。启动复用 session controller 的 `composeAgent` 和 `agents.create`（与原生 fork 相同），不写 `parentSession`，并挂进已有工作区。
- `lib/store.js`：切点计算、摘要、快照文件读写。
- `lib/client.js`：Web 客户端，提供按钮和「Fork 库」标签页。
- 测试：`node --test test/*.test.js`
