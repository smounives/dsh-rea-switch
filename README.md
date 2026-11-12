# dsh-rea-switch

DSH 插件：在 **设置 → REA** 里一键启用/停用 REA MCP 服务器（`rea-mcp` 或 `mcp-rea` 行），并在输入框上方的 dock 里放一个小圆点按钮。

关闭后，REA 那些 `mcp__rea__*` 工具定义不再进入 system prompt（一台装有完整 REA 的机器上实测：约 229 个工具、~37k tokens，占 57k 系统提示词的绝大部分），下一轮请求起生效；重新打开即恢复。REA 进程也不会启动，省掉一个常驻的 `node rea.mjs mcp`。

## 为什么需要插件

`rea-mcp` 这一行不是你 profile 里的组合包，而是 `~/.dsh/cordis.patch.yml`（home patch）用 `- insert:` 插进去的。patch 的应用顺序是：

```
bundle patches → profile patch → home patch → 启动参数 overlay
```

home patch 排在 profile patch **之后**，所以往 profile patch 里写 `- id: rea-mcp / disabled: true` 是无效的（应用时该行还没被 insert 出来）；`plugin_manager` 也因此把这一行判为 `unaddressable`，插件页里管不到它。唯一有效的位置是 home patch 里 `insert:` 块**之后**——本插件就是在文件末尾追加一段带标记的覆盖行：

```yaml
# >>> dsh-rea-switch: managed block — toggle from Settings → REA
- id: rea-mcp
  disabled: true
# <<< dsh-rea-switch
```

行 id 有两种来源，本插件都认，写覆盖块时用实际命中的那个 id：

- `rea-mcp` — 上游 `rea setup --client dsh` 写进 home patch 的 `- insert:` 行；
- `mcp-rea` — `dsh-plugin-rea`（一键装 REA 的 bundle）自带的行，在 npm 包内的 `cordis.patch.yml` 里，属于 **bundle patch** 层。

两者模块名都是 `@deepseek-ai/dsh-mcp-client`、`serverName` 都是 `rea`，而 DSH 对同名 server 只保留一个，所以同一时刻最多只有一行是活的。bundle 行在 profile patch **之前**就已经被 insert，因此 home patch 末尾那条 `- id: mcp-rea / disabled: true` 同样能覆盖它——两种安装方式都能开关。

patch 的行覆盖是浅合并：只给 `id` + `disabled`，原有 `name`、`config`（command / args / env）都不受影响。启用时这段块被**整段删除**，文件回到原样——所以不会出现「插件替你写了个 `disabled: false`，把你自己在 home patch 里的设置压掉」这种事。

写入用临时文件 + `rename` 原子替换，只动自己这两行标记之间的内容，其余行（注释、`!!js`、其它行）保持字节不变。

## 生效方式

`dsh-hmr` 监听 profile manifest 和两份用户 patch；home patch 改动后自动重新组合，REA 行被停止/启动。插件在写完后最多轮询 8 秒确认 loader 里那一行（`rea-mcp` 或 `mcp-rea`）的状态真的翻转：

- 翻转了 → `applied: true`，界面提示「已生效」
- 没翻转（例如 HMR 被禁用的 headless 宿主）→ `restartRequired: true`，界面提示重启 DSH

## 安装

DSH 左侧 **插件** 菜单 → **添加插件**，填入仓库地址即可，不需要 `git clone`：

```
https://github.com/smounives/dsh-rea-switch
```

DSH 会直接把它作为依赖装进 profile；装完出现在设置页，改完宿主半源码需要重新安装并重启 DSH。没有原生依赖、没有 `postinstall`，macOS / Linux / Windows 都是同一条路径。

本机开发时，也可以让 agent 调 `plugin_manager`（`action: install_bundle`，`target` 填仓库地址或本地目录绝对路径）。

## 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/plugins/dsh-rea-switch/status` | 行是否存在、是否启用、home patch 路径、受管块状态、当前 `mcp__rea__*` 工具数 |
| POST | `/plugins/dsh-rea-switch/state` | `{enabled:boolean}`；需要 `x-dsh-rea-switch: manage` 请求头 |

两个路由都走 `connection.requestRejection()` 的同源校验。

## 结构

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 宿主半：读写 home patch、轮询 loader 状态、挂路由 |
| `lib/patch.js` | 纯函数：受管块的插入/替换/删除，注释与其它行不动 |
| `lib/client.js` | 客户端半：`settings.section` 面板 + `conversation.composer.dock` 小按钮 |
| `cordis.patch.yml` | 插入宿主插件行 |
| `test/*.test.mjs` | 28 个测试：块渲染、幂等、往返还原、CRLF、状态收集、拒绝路径、客户端注册 |
| `scripts/verify-toggle.mjs` | 端到端验证：写入/移除覆盖块，观察 `rea.mjs` 子进程消失/恢复，结束时还原文件 |

跑测试：

```sh
node --test test/
```

跑端到端验证（会临时改 home patch，结束自动还原）：

```sh
node scripts/verify-toggle.mjs
```

本机实测：home patch 写入后 **约 2.2 秒** 重新组合完成（三次测量 2157 / 2164 / 2178 ms），REA 的 `rea.mjs mcp` 子进程随之停止/拉起，文件还原后与原始内容逐字节一致。插件等待窗口 8 秒，留了约 3.6 倍余量。

## 平台（macOS / Linux / Windows）

两个半都没有平台假设：

- **宿主半**只用 `node:fs/promises`、`node:path` 和 HTTP，没有原生模块、没有 `child_process`、没有 shell、没有 `process.platform` 分支；路径一律 `join(profileContext.home, 'cordis.patch.yml')`，盘符和带空格的用户名交给 Node 处理。
- **客户端半**是纯浏览器代码（`fetch` + `navigator.language`），跟操作系统无关。
- **换行风格跟随文件**：CRLF 的 patch 写回仍是 CRLF，不会把整个文件改成 LF（Notepad / VS Code 默认 CRLF 的 Windows 检出不会被弄脏）。
- **原子替换**：POSIX 上直接 `rename`；Windows 上目标文件被编辑器、索引或杀软短暂占用时会返回 `EPERM`/`EBUSY`，插件重试 6 次再报错。
- **编码**：读到 UTF-16 BOM 时拒绝写入并报错，而不是把 UTF-8 的块拼进 UTF-16 文件。Windows 上 PowerShell 5.1 的 `>` 重定向就会写成 UTF-16，遇到这种情况请用 UTF-8 编辑器另存。
- 唯一平台相关的是 `scripts/verify-toggle.mjs` 里的 `pgrep`（仅 macOS/Linux）：Windows 上自动跳过进程探测，只验证文件往返。

**没有实机验证**：只在 macOS 上跑过（28 个测试 + 真实 home patch 的关→开往返）。测试是纯 Node、无平台依赖，可直接在 Windows/Linux 上 `node --test test/`；生效依赖的 `dsh-hmr` 用 chokidar 监听，跨平台由它保证。

改宿主半源码后需要重启 DSH 才生效（Node 的 ESM 缓存不会热替换已加载模块）；改客户端半刷新页面即可。

## 已知边界

- 只认 `id: rea-mcp` 或 `id: mcp-rea`、且模块名为 `@deepseek-ai/dsh-mcp-client` 的行；同名不同模块时拒绝动手。两行同时存在时优先取正在运行、且模块名匹配的那一行（DSH 对同名 server 只会让一行生效）。
- 如果这两种行都不存在（没跑过 `rea setup --client dsh`，也没装 `dsh-plugin-rea`），状态显示「未配置」，开关禁用（没有可开关的对象）。
- 启动参数 `--patch` 的 overlay 优先级高于 home patch，那种情况下写入了也不会翻转，界面会提示重启而不是假装成功。
- 这里的「229 个工具 / ~37k tokens」是本机 2026-11 的实测值，仅作提示文案，不参与逻辑。
