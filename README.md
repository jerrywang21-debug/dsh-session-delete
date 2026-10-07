# dsh-session-delete · 侧边栏「删除会话」按键

[English](README.en.md) | 中文

给 DeepSeek Harness（DSH）Web 界面的会话列表补一个**删除**动作：会话行 `⋯` 菜单里多一行 **删除会话**，行尾悬停按钮里多一个垃圾桶图标；确认后该会话从列表消失，**数据被移进系统废纸篓**，需要时还能从废纸篓里拿回来。

DSH 自带的会话菜单只有 **重命名 / 分叉会话 / 归档会话**。归档只是把会话从列表里藏起来，日志和记账位都留着；本插件的删除是把会话从 Harness 里移除，但**不做不可逆的抹除**。

## 界面表现

| 位置 | 表现 |
| --- | --- |
| 会话行 `⋯` 菜单 | 「删除会话」一行，红色高亮，位于「归档会话」下方（`order: 500`） |
| 会话行悬停按钮 | 一个垃圾桶图标按钮（`order: 300`，在归档、钉住之后），带 tooltip |
| 二次确认 | 危险操作确认框，**必须勾选**确认项后才能点「永久删除」；确认框里写明该会话在磁盘上占多大 |
| 删除完成 | 一个说明框，直接给出废纸篓里的路径，方便取回 |
| 拒绝时 | 说明框给出宿主返回的原因（例如「该会话正在运行一个回合」） |

如果删掉的正好是当前打开着的会话，主区域的选择会先被释放，不会继续显示一个已经不存在的会话。

## 「删除」到底动了什么

按 DSH 真实的存储布局，逐个会话处理：

| 目标 | 处理方式 |
| --- | --- |
| `<DSH_HOME>/sessions/<工程目录键>/<会话 ID>/session.v<N>.jsonl.zstd`（含锁文件与同目录其他产物） | **移动到废纸篓**（macOS 为 `~/.Trash`） |
| `<DSH_HOME>/storages/session_projcache/sessions/<会话 ID>.json` | **移动到废纸篓** |
| `<DSH_HOME>/storages/workspace.json` 里的 `pinnedSessionIds[]`、`archivedSessionIds[]`、各 `workspaces[*].sessionIds[]` | 就地摘除（这是**索引**，不是会话数据；留着会指向已经不存在的日志） |
| `<DSH_HOME>/attachments/v1/objects/`（按内容寻址的附件对象） | **不碰**：多个会话可能共享同一份，按会话删除会误伤别的会话 |

工程目录键（`projectKey`）是**有损**编码（分隔符折叠、超长截断），无法由会话 ID 反推，所以本插件是**扫描** `sessions/` 下每个工程桶来定位会话目录，而不是重算路径 —— 这样即使会话头已经读不出来，删除依然有效。

同一卷内移动用 `rename`（原子、瞬时、保 inode）；跨卷（`EXDEV`）时先复制、确认落地后再删原目录，任何一步失败都不会丢数据。废纸篓里的名字带 `YYYYMMDD-HHMMSS` 时间戳，重复删除不会互相覆盖。

## 不冲突设计

这是**独立插件**，不修改、不覆盖、不补丁任何现有包：

- **只用官方声明的槽位**：`sidebar.workspaces.session.menu.item`、`sidebar.workspaces.session.row.action`、`shell.overlay`，一律通过 `ctx.slots.inject()` 注册（槽位声明出现才注册，声明折叠就撤掉）。没有 DOM 打补丁，也没有读 React fiber 取会话 ID。
- **id 全部带命名空间前缀**（`session-delete.menu` / `session-delete.row` / `session-delete.confirm`），**不复用**内置 id（`pin`/`rename`/`fork`/`archive`），因此不会遮蔽任何已有动作。
- **自有路由**：HTTP 面在 `/api2/dsh-session-delete/{inspect,delete}`，不占用、不覆盖任何现有路由。
- **零运行时依赖**：宿主半边只用 `node:` 内建模块；浏览器半边只用 Module Loader 提供的 `react` 与官方 primitives，无需构建步骤。
- **可选服务一律用 `ctx.get()` 读取**（`agents`、`sessions`、`workspaceRegistry`、`dshHomePath`），缺谁都不影响加载 —— 无头 profile 里它就是一个空操作。

## 安全栅栏

删除是不可逆操作的入口，所以这个自建 JSON 接口有三重栅栏：

1. 只接受 `POST`；
2. 只接受 `application/json`（跨站页面无法在不触发 CORS 预检的前提下发出该 Content-Type，而本路由不响应预检）；
3. 只接受回环 `Host`（可用环境变量 `DSH_SESSION_DELETE_TRUSTED_HOSTS` 追加受信主机名，逗号分隔）。

请求体上限 64 KiB；会话 ID 必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`，拼进路径前再做一次与存储后端一致的转义，另外还有「结果必须仍在 sessions 根目录之下」的复核。

**正在运行的会话拒绝删除**：判定用 DSH 自己的 `agents.get(id).status === 'running'`，也就是侧边栏运行指示灯读的同一个事实，所以界面提示与守卫不会互相矛盾。已经打开、但没在跑的会话可以正常删除。

## 安装

本包是一个 **DSH bundle**（`package.json` 里声明了 `dsh.bundle.patch` → 包内的 `cordis.patch.yml`）。两种装法，**二选一，不要同时用**：

**A. 作为 bundle 安装**（推荐）

把包名加进 profile 的 `dsh.profile.bundles`，例如 `~/.dsh/profiles/desktop/package.json`：

```json
{
  "dependencies": {
    "dsh-session-delete": "link:/Users/jerry/Desktop/DeepSeek工作区/dsh-session-delete"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-session-delete"]
    }
  }
}
```

然后让 pnpm 把链接落到 `node_modules`（`pnpm install`，或市场里任意一次安装/更新都会顺带完成）。

**B. 手写一行 insert**

在 profile 的 `cordis.patch.yml` 里加：

```yaml
- insert:
    - id: session-delete
      name: 'dsh-session-delete'
```

⚠️ 如果 profile 已经把本包装进 `dsh.profile.bundles`，就**不要**再写这行 insert —— 那会加载两次，宿主半边会因路由重复注册而报错。

`dsh.client.platform` 已声明为 `web`，插件包同时提供宿主半边（`index.js`）和浏览器半边（`client.js`）。

两半都在**应用启动时**装载：宿主半边启动时求值，浏览器半边的代码字节启动时快照。当前 DSH Desktop 构建没有可用的 HMR，所以**装好后需要重启 DSH**，仅刷新页面不够。

## 配置

| 环境变量 | 默认 | 作用 |
| --- | --- | --- |
| `DSH_SESSION_DELETE_TRASH` | macOS `~/.Trash`；其他平台 `<DSH_HOME>/trash` | 自定义「废纸篓」目录 |
| `DSH_SESSION_DELETE_TRUSTED_HOSTS` | 空 | 追加受信主机名（逗号分隔），用于非回环部署 |

## 已知限制

- **正在运行的会话不能删**（见上）。
- **已装载的空闲会话删完后进程内还有副本**：会话对象归创建它的 fiber 所有，插件无权处置（`AgentHandle.dispose()` 只给创建者）。磁盘和列表都已清理干净，重启 DSH 后彻底释放。
- **「放回原处」由 Finder 决定**：本插件是把目录移进 `~/.Trash`，Finder 一般可以直接拖回去；是否能点「放回原处」取决于 Finder 自己记录的元数据，本插件不写它。
- **工作区记录的摘除可能被回滚**：优先走 Workspace registry 服务（`unpinSession` / `unarchiveSession` / `detachSession`，内存与磁盘同步），服务不可用时才退化成原子改 `workspace.json`。回滚后的残留是一个指向「已不存在的会话」的 ID，任何分组视图都不会渲染它。
- 只对 Web 界面生效；无头 profile 下宿主半边加载为空操作。

## 测试

```sh
node --test
```

零依赖，用 `node:test`，三层：

- `test/session-store.test.mjs` —— 真实文件系统：在临时目录里搭出与 DSH 一致的存储布局，断言删除后废纸篓里剩什么、原目录剩什么、相邻会话有没有被误伤、命名冲突与「已在废纸篓里」的幂等。
- `test/host.test.mjs` —— 假 Cordis context 与假 `req`/`res`：覆盖三重栅栏、运行中拒绝、registry 服务路径与其失败回退、入废纸篓、两个广播事件、无存储时的收敛、以及 fiber 释放后路由的注销。
- `test/client.test.mjs` —— 假 `__ModuleLoader__`、假 `require`、假 ctx：覆盖三个槽位注册（名称/id/顺序/不遮蔽内置 id）、中英文字典同键、菜单项与悬停按钮的结构、确认→删除→废纸篓提示的完整流程、拒绝时的提示、以及「不关掉无关会话」。

## 许可

MIT。
