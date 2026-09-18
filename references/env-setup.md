# 环境与 DevSpace 安装（阶段 0–1）

> 阶段 0 = 环境自检 + 补齐依赖；阶段 1 = 安装 DevSpace。
> 主流程见 SKILL.md；本文件是这两步的完整细节。

## 阶段 0：环境自检 + 补齐依赖

**第一步永远是跑自检，不要凭感觉假设环境是好的。**

```bash
SK=~/.workbuddy/skills/chatgpt-mcp-connector/scripts
node $SK/env-check.mjs              # 只读自检
node $SK/env-check.mjs --install    # 确认缺失项后再加这个（先征得用户同意）
```

### 依赖清单与要求

| 依赖 | 要求 | 为什么需要 | 缺失后果 |
| --- | --- | --- | --- |
| **Node** | README 写 `>=22.19 <27`；CLI 内 `assertSupportedNode` 实际放宽到 `>=20.12 <27` | 跑 DevSpace | 启动即报错 |
| **npm** | 随 Node | 装 DevSpace | 装不上 |
| **Git** | 任意版本 | worktree 模式；Windows 上 Git 同时提供 Git Bash | 只能用 checkout 模式 |
| **Bash** | Git Bash / WSL / MSYS2 / Cygwin | DevSpace 执行 shell 命令 | **纯 PowerShell / cmd 不支持** —— Windows 上最容易踩的坑 |
| **Tailscale** | `>=1.38.3`（1.52 起 CLI 语法变更，建议新版） | 提供公网 HTTPS 端点（ChatGPT 够不到 `127.0.0.1`） | ChatGPT 无法连接 |
| **DevSpace** | `@waishnav/devspace` 最新版 | 本体 | — |
| **better-sqlite3** | 能加载 | DevSpace 的状态存储（OAuth/workspace 持久化） | 启动时原生依赖检查失败 |

### 各平台安装命令（实测/官方来源）

| 依赖 | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Node | `winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements` | `brew install node@22 && brew link --overwrite --force node@22` | `curl -fsSL https://deb.nodesource.com/setup_22.x \| sudo -E bash - && sudo apt-get install -y nodejs` / `sudo dnf install -y nodejs` / `sudo pacman -S nodejs npm` |
| Git | `winget install -e --id Git.Git --accept-package-agreements --accept-source-agreements` | `brew install git` | `sudo apt-get install -y git` 等 |
| Bash | 同上装 Git.Git（自带 Git Bash）；或 `winget install -e --id Microsoft.WSL` | `brew install bash` | 通常自带 `/bin/bash` |
| Tailscale | `winget install -e --id Tailscale.Tailscale --accept-package-agreements --accept-source-agreements` | `brew install --cask tailscale` | `curl -fsSL https://tailscale.com/install.sh \| sh` |
| DevSpace | `npm install -g @waishnav/devspace` | 同左 | 同左 |
| better-sqlite3 | `npm rebuild better-sqlite3` | 同左 | 同左 |

> winget 包 ID 已核实存在：`OpenJS.NodeJS.LTS`（**24.19.0**）、`OpenJS.NodeJS`（26.7.0）、
> `Git.Git`（2.55.0.3）、`Tailscale.Tailscale`（1.102.4）。
> **选 LTS 而不是 current** —— current 已经是 26.x，逼近 DevSpace 的 `<27` 上限，LTS 更稳。

### 装完之后的两个坑

1. **PATH 不会自动刷新。** 用包管理器装完 Node/Git 后，**当前终端识别不到**，
   需要新开一个终端（或重启工具）。装完务必**重跑一次 `env-check`** 确认。
2. **Windows 上 `npm` 不能直接 spawn。** Node 不允许直接执行 `.cmd`／`.bat`（会 EINVAL），
   必须 `shell: true`；而 shell 模式下 Node 只把命令和参数用空格拼接、**不给带空格的路径加引号**，
   于是 `C:\Program Files\nodejs\npm.cmd` 会被从空格处截断，报
   `'C:\Program' 不是内部或外部命令`。正确写法是自己加引号后再走 shell：

   ```js
   execFileSync(`"${npmPath}"`, args, { shell: true, windowsHide: true })
   ```

   本技能的 `env-check.mjs` 已处理；手写脚本时注意这个坑。
   同一个坑在 `devspace-bootstrap.mjs` 的 `run()` 里也做了处理 —— tailscale 也可能被装成 `.cmd` shim。

### 快速手工确认

```bash
node -v; npm -v; git --version; bash --version
```

## 阶段 1：安装 DevSpace

```bash
npm install -g @waishnav/devspace      # 或一次性用 npx @waishnav/devspace <cmd>
devspace -v                            # 期望 1.0.8（查最新：npm view @waishnav/devspace version）
devspace doctor                        # 诊断 Node/ABI/平台/Git/Bash/publicUrl/allowedHosts/sqlite
```

常见安装问题：

- **`better-sqlite3` 加载失败**（原生依赖装在了另一个 Node 运行时下）：
  `npm rebuild better-sqlite3`，再 `devspace doctor`。
- **Node 版本不符**：用 `nvm` / `fnm` / `mise` 装 22 LTS。
- **命令找不到**：改用 `npx @waishnav/devspace <cmd>`。
- **`Cannot find module '...\dist\cli.js'`（本机实测）**：`devspace` 那个 shell 脚本 shim 依赖
  `sed` / `dirname` / `uname`，在 PATH 残缺的 shell 里会算错路径。绕过办法是直连 CLI：

  ```bash
  "C:/Program Files/nodejs/node.exe" "C:/Users/<你>/AppData/Roaming/npm/node_modules/@waishnav/devspace/dist/cli.js" serve
  ```

### CLI 命令面（1.0.8 实测 `--help`）

```
devspace                 运行首次设置（如需要）然后启动服务
devspace serve           启动服务
devspace init            创建/更新 ~/.devspace/config.json 与 auth.json
devspace doctor          显示配置、运行时、原生依赖状态
devspace config get      打印持久化配置
devspace config set publicBaseUrl <url|null>     ← 注意：只支持这一个键
devspace agents ls|run|continue|show|daemon
devspace -v, --version
```

> `config set` **只能改 `publicBaseUrl`**。改 `allowedRoots` 必须直接编辑 `config.json` 或用环境变量。
