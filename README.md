<div align="center">

# 🌿 dsh-fork-map

**把对话的某一刻存下来，以后想从这里重来几次都行。**

给 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) Web 用的 Fork 库插件。
每个工作区一个持久化 Fork 库。Fork 是可以反复取用的「上下文资源」，不是一次性按钮。

![DSH](https://img.shields.io/badge/DSH-web%20plugin-4f6bed)
![Node](https://img.shields.io/badge/node-%E2%89%A5%2022-339933)
![License](https://img.shields.io/badge/license-MIT-blue)

</div>

---

## 为什么要它

DSH 原生的「分叉」按钮点一下就立刻生成一个新会话，分叉点本身不会留下来。想从同一个位置再试一次，你得回到原会话、找到那一轮、再点一次。原会话一旦删了，那个位置就彻底没了。

实际用起来常见这些情况：

- 花了二十轮把项目背景、约束、代码结构讲清楚，接下来想**从这个状态出发**试三种不同方案。
- 某一轮回复写得很好，想把它当成**以后反复用的起点**，比如固定的 code review 上下文、某个模块的讲解上下文。
- 会话越聊越乱，想**回到之前某个干净的节点**重新开始，又不想留着那个乱掉的会话。

dsh-fork-map 把分叉点变成一个独立、持久、可命名的东西：

|                    | 原生分叉                 | Fork 库                                       |
| ------------------ | ------------------------ | --------------------------------------------- |
| 点一下之后         | 立刻变成一个新会话       | 存进库里，当前对话不受打断                    |
| 能用几次           | 一次                     | 不限，每次都新建独立会话                      |
| 源会话删了         | 无法再从那个位置分叉     | 不受影响，快照是完整独立的                    |
| 怎么找回来         | 去原会话里翻到那一轮     | 「Fork 库」标签页按工作区列出                 |
| 命名、备注         | 不支持                   | 支持                                          |
| 谱系               | 侧栏父子嵌套             | Fork 图：从 Fork 启动的会话再存 Fork，自动挂成子节点 |

## 三步用法

### 1. 存：在任意一轮回复上点「存为 Fork」

每轮回复下方的操作栏里，原生分叉按钮旁边多了一个书签图标。点一下，到这一轮为止的完整上下文就存进当前工作区的 Fork 库，对话本身不受打断。

```
  …助手的回复…

  👍  👎  ⑂  🔖   已存入 Fork 库
             ↑
         存为 Fork
```

- 同一轮重复点只存一份，会提示「这一轮已在 Fork 库中」。
- 还在生成中的轮次不能存，等它结束再点。

### 2. 看：打开「Fork 库」标签

对话区顶部「对话 / 轨迹」旁边多了一个「Fork 库」标签，里面是当前工作区的 Fork 图：

```
Fork 库   my-project                       [当前工作区 | 全部]  刷新

my-project   ~/code/my-project · 3 个 Fork
┌────────────────────────────────────────────────────┐
│ 项目背景讲清楚了                     12 轮 · 2 天前 │
│ 最后提问  鉴权模块现在的问题在哪？                  │
│ 最后回复  主要有三处：token 刷新没加锁……            │
│ 从这里分别试方案 A / B / C                          │
│ 来源：重构鉴权（已删除） · 快照 84K                 │
│ 已启动 3 次：方案A  方案B  方案C                    │
│ [从这里启动新会话] [改名] [改备注] [删除]           │
└────────────────────────────────────────────────────┘
   ┆
   ├─ ┌──────────────────────────────────────────┐
   ┆  │ 方案 B 跑通了               16 轮 · 1 天前 │
   ┆  └──────────────────────────────────────────┘
   └─ ┌──────────────────────────────────────────┐
      │ 方案 C：先改数据库          15 轮 · 今天   │
      └──────────────────────────────────────────┘
```

- 每张卡片显示轮数、最后一问、最后一答、备注、来源会话和启动记录。
- 来源会话和启动过的会话都能点，点了直接跳过去。已删除的会话会划线标出。
- 在某个 Fork 启动出来的会话里再存 Fork，新 Fork 会挂在原 Fork 下面，谱系一眼能看清。
- 默认只看当前工作区，切到「全部」可以看所有工作区。

### 3. 用：点「从这里启动新会话」

新会话带着到那一轮为止的完整上下文直接打开，标题为 `<名称> · Fork N`，并归入同一路径的工作区。可以连续点，每次都是一个全新的独立会话，互不影响。

双击名称可以改名，备注适合写「这个起点适合拿来干什么」。

## 安装

需要 DSH Web（`@deepseek-ai/dsh`）和 Node.js 22 或更高版本。

```sh
git clone https://github.com/Hercules-debug/dsh-fork-map.git
dsh plugin --profile web add /path/to/dsh-fork-map
```

装好后**重启 `dsh web`**，再刷新浏览器。插件的宿主部分要在进程启动时加载，只刷新页面不够。

<details>
<summary>手动安装（不用 <code>dsh plugin</code>）</summary>

1. 在 `~/.dsh/profiles/web/package.json` 里：
   - `dependencies` 加 `"dsh-fork-map": "link:/path/to/dsh-fork-map"`
   - `dsh.profile.bundles` 加 `"dsh-fork-map"`
2. 在 profile 目录运行 `pnpm install`，或者手动把 `node_modules/dsh-fork-map` 软链到仓库目录。
3. 如果 profile 的 `cordis.patch.yml` 里有 `- id: fork-map` 加 `disabled: true`，把这两行删掉。
4. 重启 `dsh web`。

</details>

## 工作原理

**Fork 是完整快照，不是指向源会话的引用。** 保存时，插件把源会话从开头到这一轮结束的全部事件取出来，压缩后单独存一份。之后不管源会话被删除还是继续往下聊，Fork 的内容都不会变。

**切点和原生分叉完全一致。** 从你点的那条回复往后找第一个 `turn/end`，再推进到下一个 `turn/start` 之前，所以轮次之间的模型切换这类事件也会带上。从 Fork 启动的会话和用原生分叉得到的会话，上下文是同一份。

**启动走 DSH 自己的会话创建流程。** 新会话用的是 session controller 的同一套组装逻辑（`composeAgent` 加 `agents.create`），由 DSH 管理生命周期，用当前选中的模型，保留源会话的 agent preset。唯一的区别是不记录父会话，所以侧栏不会把它嵌在一个可能已经删掉的会话下面。Fork 和会话之间的关系由 Fork 库自己记录。

### 数据存在哪

| 内容                     | 位置                                                       |
| ------------------------ | ---------------------------------------------------------- |
| Fork 索引（名称、备注、来源、启动记录） | `~/.dsh/storages/fork_library.json`（DSH storage domain） |
| 上下文快照               | `~/.dsh/storages/fork_library_snapshots/<forkId>.json.zst` |

快照用 zstd 压缩，写入时先写临时文件再原子替换，不会留下半截文件。删除 Fork 只删快照和索引，已经启动的会话不受影响。

### HTTP 接口

全部挂在 DSH 的 `/api` 鉴权范围内，跟 GUI 用同一套登录 cookie，不对外暴露。

| 方法 | 路径                          | 请求体                                   |
| ---- | ----------------------------- | ---------------------------------------- |
| GET  | `/api/forkLibrary.list`       | 无                                       |
| POST | `/api/forkLibrary.save`       | `{ sessionId, messageId?, atSeq?, label? }` |
| POST | `/api/forkLibrary.launch`     | `{ forkId }`，返回 `{ sessionId }`        |
| POST | `/api/forkLibrary.update`     | `{ forkId, label?, note? }`              |
| POST | `/api/forkLibrary.delete`     | `{ forkId }`                             |

## 项目结构

```
lib/
  index.js     宿主插件入口：打开存储、注册 /api/forkLibrary.* 路由
  library.js   保存 / 启动 / 改名 / 删除
  store.js     切点计算、摘要提取、快照读写（不依赖 DSH，可单测）
  client.js    Web 端：「存为 Fork」按钮和「Fork 库」标签页
test/
  library.test.js
cordis.patch.yml   把插件挂进 profile
```

开发与测试：

```sh
npm test    # node --test test/*.test.js
```

测试覆盖：切点规则、未结束轮次的拒绝、同轮去重、同一 Fork 连续启动两次、源会话删除后仍能启动、子 Fork 谱系，以及删除父 Fork 后子节点的处理。

## 已知限制

- 只能在已经结束的轮次上存 Fork。
- 子代理（subagent）会话不能存 Fork。
- 新会话的工作目录固定为保存时的路径。如果这个目录被删或被移动，从 Fork 启动的会话可能无法正常工作，也不会归入任何工作区。
- 改了插件的宿主部分（`lib/index.js`、`lib/library.js`、`lib/store.js`），要重启 `dsh web` 才生效。

## License

MIT
