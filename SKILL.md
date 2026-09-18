---
name: chatgpt-mcp-connector
description: "从 0 到 1 把本地 MCP 服务器（DevSpace）接入 ChatGPT 网页版：自检并补齐环境依赖（Node/npm/Git/Bash/Tailscale，缺失可自动安装）→ 装 DevSpace → 开 Tailscale Funnel 公网隧道 → 写配置 → 在 ChatGPT 插件页建自定义连接器并完成 OAuth 授权。支持 Windows / macOS / Linux 三平台（各平台的安装命令、路径写法、shell 解析、Tailscale 服务模型差异均已处理，macOS/Linux 未实机验证）。含容错：配置损坏拒绝写盘、自动备份与回滚（.bak/rollback）、原子写入、超时重试、临时隧道降级、错误分级。并明确标出必须由用户人工完成的步骤（Tailscale 浏览器登录、Funnel 首次批准、ChatGPT 建连接器与填 Owner password 授权），脚本检测到未登录/未启用会打 🙋 主动提醒用户操作。也用于诊断 'does not implement OAuth' / 'Something went wrong' / invalid_client / path is outside allowed roots / bash 或 shell 工具持续异常（所有命令都失败、连 echo 也不例外，返回 RuntimeException 或乱码 —— Windows 上通常是 Git 装在非 C 盘、bash 被 System32 里的 WSL 启动器顶掉）/ 配置文件损坏等问题。"
agent_created: true
---

# ChatGPT 自定义 MCP 连接器：从 0 到 1 接入本地 MCP 服务器

把本地自托管 MCP 服务器（本文以 `Waishnav/devspace` 为主）通过公网 HTTPS 隧道接入 ChatGPT 网页版，
让 ChatGPT 直接读写本地代码、执行命令。

**实测环境**：Windows 11 + Git Bash，DevSpace `1.0.8`，Tailscale `1.102.4`，winget `1.29.290`，
Node `24.15.0`，ChatGPT 新版中文 UI + Plus 账号。
版本差异会影响命令语法（尤其 Tailscale），照做前先跑一遍 `--version`。

**平台支持**：Windows / macOS / Linux 三平台都支持，脚本无需改动。
差异集中在**依赖安装方式、shell 解析、Tailscale 服务模型、路径写法**四处 ——
见 `references/cross-platform.md`。
⚠️ 只有 Windows 做过实机验证；macOS / Linux 的结论来自 DevSpace 源码，**未实机跑过**，
实机结果与文档不符时以实际输出为准。

## 何时使用

- 「让 ChatGPT 网页版驱动本地 codex / 读我本地项目」「把本地 MCP 接到 ChatGPT」
- 报错 `MCP server ... does not implement OAuth` / `Something went wrong...`
- **`bash` / shell 工具持续异常**：`git status`、`cargo fmt`、`echo`、`ls` 全部失败，
  ChatGPT 显示 `RuntimeException` 或乱码。**`echo` 也失败是关键判据**（它是 bash 内建命令，
  它都挂说明 shell 根本没起来，不是 PATH 找不到工具）→ 见 `references/troubleshooting.md`
  的「Windows：bash 被 WSL 启动器顶掉」
- 隧道域名变了、`devspace serve` 重启后 ChatGPT 连不上，要重建或 Refresh 连接器
- 要让 ChatGPT 换一个可访问目录（见 `references/devspace-config.md`）
- **在 macOS / Linux 上部署**（安装方式、路径写法、Tailscale 权限模型都不一样）
- **改了配置想回退**（`rollback`）、**动配置前想先预演**（`apply --dry-run`）、
  **`config.json` / `auth.json` 损坏或被截断**（脚本会拒绝写盘并另存 `.corrupt-*`）
- Funnel 用不了、想换别的公网暴露方式（见 `references/troubleshooting.md` 降级路径）

## 执行流程（0 → 1）

| 阶段 | 目标 | 关键动作 | 验收信号 | 🙋 人工介入 |
| --- | --- | --- | --- | --- |
| 0 | 环境自检 + 补齐依赖 | `env-check.mjs`（`--install` 自动装缺失项） | 脚本报「✅ 全部就绪」，且 **Bash 项为 `[ok]`**（报 `[不可用]` 时 shell 工具会全废，见下） | 装包可能弹 UAC |
| 1 | 装 DevSpace | `npm i -g @waishnav/devspace` | `devspace -v` → `1.0.8` | — |
| 2 | 装 + 登录 Tailscale | `winget install -e --id Tailscale.Tailscale` → `tailscale up` | `tailscale status` 有 Self | **🙋 浏览器登录授权** |
| 3 | 开公网隧道 | `tailscale funnel --bg 7676` | `funnel status` 显示 `proxy http://127.0.0.1:7676` | **🙋 首次需点批准链接** |
| 4 | 写 DevSpace 配置 | `devspace init`（交互）**或** 脚本 / 直接写配置（全自动） | 启动日志 `allowed roots:` 正确 | — |
| 5 | 启动服务 | `devspace serve` | `/healthz` 本地+公网都 200 | — |
| 6 | ChatGPT 建连接器 | `chatgpt.com/plugins` → `创建应用` → OAUTH | 日志出现 `openai-mcp/1.0.0` + `200` | **🙋 全程浏览器操作** |
| 6b | 授权 | `/authorize` 页填 Owner password | 302 回跳 `chatgpt.com/connector/oauth/...?code=` | **🙋 密码只能人填** |

## 🙋 必须由用户亲自完成的步骤

这条流程**没法全自动跑完**。登录、浏览器授权、后台开关这三类步骤脚本代替不了 ——
要么需要账号凭据，要么只能在浏览器里点。
**碰到下面这些点必须停下来交给用户，不要静默等待、更不要代做。**

| # | 阶段 | 要用户做什么 | 为什么不能自动 | 做完怎么确认 |
| --- | --- | --- | --- | --- |
| 1 | 0 环境 | winget 安装时可能弹 **UAC 提权**确认 | 需要管理员授权，脚本按不了 | 安装命令返回成功 |
| 2 | 2 Tailscale | `tailscale up` 打印的**登录链接** → 浏览器打开、登录、授权设备加入 tailnet | 需要账号凭据 + 浏览器会话 | `tailscale status` 出现 Self，IP 为 `100.x` |
| 3 | 2 Tailscale | 后台没开 **MagicDNS** 时去 admin 后台 DNS 页打开 | 账号级策略开关 | `tailscale status --json` 里有 `Self.DNSName` |
| 4 | 3 Funnel | **首次**启用 Funnel 会另给**批准链接** → 浏览器点同意 | 账号级 ACL 策略 | `funnel status` 出现 `(Funnel on)` |
| 5 | 6 ChatGPT | 浏览器登录 ChatGPT → 设置 → 账户安全与登录 → 打开**开发者模式** | 需要登录态 | 设置页开关为开 |
| 6 | 6 ChatGPT | 在 **`chatgpt.com/plugins`** 点「创建应用」并填表提交 | 浏览器交互（React 表单） | 列表出现 DevSpace，或 URL 变为 `#settings/Connectors?...` |
| 7 | 6b 授权 | 在 `/authorize` 页填 **Owner password** → 点 `Authorize DevSpace` | 凭据只能由人输入 | 302 回跳 `chatgpt.com/connector/oauth/<id>?code=...` |
| 8 | 6b | 新开一个对话，从工具菜单**手动挂上** DevSpace | 没有公开 API | 对话里能真的调用工具 |

### 提醒话术（直接照用）

到这些点就明确说「现在需要你操作」，并交代**做完怎么确认**：

> 🙋 **需要你操作**：`tailscale up` 已经打印了一个链接，请用浏览器打开并完成登录授权。
> 完成后跟我说一声，我接着跑 `tailscale status` 确认。

> 🙋 **需要你操作**：请在浏览器打开 `https://chatgpt.com/plugins` → 右上角「创建应用」，
> 服务器 URL 填 `https://<域名>/mcp`，身份验证保持 `OAUTH`，勾选确认后点「创建」。

> 🙋 **需要你操作**：页面会跳到授权页，请填 Owner password（在 `~/.devspace/auth.json`）并点授权。
> **密码只在浏览器里填，不要发到聊天或日志里。**

脚本侧会自动提示：`env-check` 与 `devspace-bootstrap check` 检测到 Tailscale 未登录、
Funnel 未启用这类情况时，会就地打 `🙋` 并在输出末尾汇总一份待办清单。

## 自带脚本

管道顺序：
`env-check`（把依赖装齐）→ `devspace-bootstrap apply`（写配置）→ `devspace serve` + `tailscale funnel`（起服务）
→ ChatGPT 插件页建连接器 + 授权。

```bash
SK=~/.workbuddy/skills/chatgpt-mcp-connector/scripts
```

### ① `scripts/env-check.mjs` —— 环境自检 + 缺失自动补齐

```bash
node $SK/env-check.mjs                             # 只读自检：打印结果 + 缺失项的安装命令
node $SK/env-check.mjs --json                      # 机器可读（agent 解析用）
node $SK/env-check.mjs --install                   # 真的执行安装
node $SK/env-check.mjs --install --only node,git   # 只装指定项
```

覆盖 **7 项依赖 + 包管理器**：Node / npm / Git / Bash / Tailscale / DevSpace / better-sqlite3，
以及 winget|brew|apt|dnf|pacman 的可用性。退出码：`0` 全就绪、`1` 有缺失、`2` 脚本自身出错。

- Node 按 `>=20.12 <27` 校验（README 口径是 `>=22.19 <27`，CLI 内部更宽）。
- Bash 会**列出所有候选并标推荐项**（★ Git Bash > MSYS2 > Cygwin > WSL > PortableGit），
  因为 Windows 上常同时存在多个 Bash，选错会导致 DevSpace 行为异常。
  WSL 入口**只检测不执行**（执行会拉起 `wsl.exe`，代价高且可能被安全策略拦截）。
- Tailscale 会读 `status --json` 的 **`BackendState`** 判断登录态，未登录时提醒用户。
- 容错：每项独立 try/catch；外部命令**带超时**（探测 15s / 安装 10min）；
  `--install` 单项失败**不中断整轮**并汇总「自动成功/自动失败/需手动/已跳过」；
  只对网络抖动重试，`ENOENT`/`EACCES` 直接放弃；退出码反映**自检当时**的状态（刚装完但 PATH 未刷新仍返回 `1`，不报假绿）。

> **⚠️ 安装前必须先征得用户同意。** 默认**不安装任何东西**；只有显式 `--install` 才会执行命令。
> 标准做法：先跑只读自检 → 把缺失项和将执行的命令给用户看 → 用户同意后才加 `--install`。

### ② `scripts/devspace-bootstrap.mjs` —— 写 DevSpace 配置

```bash
node $SK/devspace-bootstrap.mjs check       # 只读体检：Node/tailscale/隧道/域名推导/现有配置
node $SK/devspace-bootstrap.mjs apply \
     --roots "D:\projects\my-app" [--port 7676] [--host 127.0.0.1] \
     [--public-base-url https://x.ts.net] [--subagents codex,claude] \
     [--dry-run] [--force]
node $SK/devspace-bootstrap.mjs rollback [--config|--auth]   # 从 .bak 恢复
```

行为保证：`check` 绝不写盘；`apply` 只改**显式传入**的键、**绝不覆盖已有 `ownerToken`**、
内容无变化时不动文件（幂等）；自动从 Tailscale 推导 `publicBaseUrl`。
它**不调用 `devspace init`**（那是交互式的、会重问所有问题）。

容错保证：配置损坏时**拒绝写盘**并另存 `.corrupt-<时间戳>`（而不是静默清空）；
写入前**自动备份 `.bak`** 并**原子替换**（临时文件 + rename）；所有校验在写盘前完成，
失败即退出、**不留半成品**。详见 `references/troubleshooting.md`。

## 分阶段速查

每步的完整说明在对应 reference 文件里，这里只给动作与验收点。

### 阶段 0–1：环境 + DevSpace → `references/env-setup.md`

```bash
node $SK/env-check.mjs                 # 依赖齐了再往下
npm install -g @waishnav/devspace
devspace -v && devspace doctor
```

验收：`env-check` 报「✅ 全部就绪」、`devspace -v` 有版本号。

> ⚠️ **Bash 那一项必须是 `[ok]`**（它会注明「冒烟测试通过」）。
> 若是 `[不可用]`，说明 DevSpace 解析出的不是真 shell —— Windows 上最常见的是
> **Git 装在非 C 盘**，于是命中 `C:\Windows\System32\bash.exe`（WSL 启动器，不是 shell），
> 结果是 ChatGPT 的 shell 工具**所有命令全失败**（`echo` 也不例外）。
> 修法见 `references/troubleshooting.md` 的「Windows：bash 被 WSL 启动器顶掉」。

### 阶段 2–3：Tailscale + Funnel → `references/tailscale-funnel.md`

```bash
winget install -e --id Tailscale.Tailscale
tailscale up                           # 🙋 用户去浏览器完成授权
tailscale status                       # 验收：有 Self，IP 为 100.x

tailscale funnel --bg 7676             # ⚠️ 绝不加 --set-path=/mcp
tailscale funnel status                # 验收：出现 (Funnel on) + proxy 行
```

`publicBaseUrl` = `"https://" + Self.DNSName`（**末尾的点要去掉**），MCP 端点 = 它 + `/mcp`。

### 阶段 4–5：配置 + 启动 → `references/devspace-config.md`

```bash
node $SK/devspace-bootstrap.mjs apply --roots "D:\projects\my-app"
cd <默认工作目录> && devspace serve     # 进程必须常驻
```

验收：启动日志里 **`allowed roots:`** 一行符合预期；`/healthz` 本地与公网都 200，
公网 `/mcp` 返回 **401**（这是**正确的** OAuth 触发点，不是故障）。

### 阶段 6：ChatGPT 连接器 + 授权 → `references/chatgpt-connector.md`

配置值准备：服务器 URL = `https://<域名>/mcp`，身份验证 = `OAUTH`，
Owner password = `~/.devspace/auth.json` 里的 `ownerToken`（43 字符明文）。

验收：服务端日志出现 **`userAgent: openai-mcp/1.0.0` + `200` + `mcp_session_created`**，
进一步看到 `tool_call ... success:true` 才算真通了。

## 三条不可违背的铁律

1. **绝不 `tailscale funnel --set-path=/mcp`** —— 挂载路径会被剥掉，公网 `/mcp` 变 `/` → 404；
   且 DevSpace 的 OAuth 路由在 `/mcp` 之外。必须代理整个 origin。
2. **连接器必须在 `chatgpt.com/plugins` 页建** —— 「设置」里只用来开开发者模式；
   两处表单字段一模一样，走错必报 `Something went wrong`。
3. **Owner password 只在浏览器授权页填写** —— 永远不要让用户把它贴进聊天或日志。

## 安全边界（必读）

- `allowedRoots` **不是操作系统沙箱**：shell 命令以**本机用户权限**运行。
- 别把含密钥、客户数据、生产配置的仓库放进去。**先用只读 prompt 验证边界。**
- 限制白名单到当前真正需要的项目，别图省事填整个磁盘（脚本会对盘符级白名单告警）。
- 注意白名单内的 softlink：已知 issue #45，路径比较是字符串级、不解析 symlink 目标。
- `DEVSPACE_ALLOWED_HOSTS=*` 会关闭 Host 校验，仅本地调试用。
- 用完关公网入口：`tailscale funnel reset`。

## 参考文件

| 文件 | 内容 | 何时读 |
| --- | --- | --- |
| `references/cross-platform.md` | **三平台对照**：依赖安装命令、路径写法、shell 解析、Tailscale 服务模型、平台差异功能（如 `download_artifact` 仅 Linux）、各平台最容易踩的坑 | **在 macOS / Linux 上操作时先读这个**；或遇到「装了却说找不到命令」这类环境问题时 |
| `references/env-setup.md` | 依赖清单与要求、各平台安装命令、装完之后的环境坑（PATH 刷新 / Windows npm shim / macOS Homebrew shellenv / Linux nvm）、DevSpace 安装与常见问题、CLI 命令面 | 阶段 0–1，或依赖装不上时 |
| `references/tailscale-funnel.md` | Tailscale 安装/登录（含三平台服务模型）、版本要求、Funnel 前置条件与语法、域名推导、关闭隧道、降级方案 | 阶段 2–3，或隧道不通时 |
| `references/devspace-config.md` | 两个配置文件、全自动写配置机制、解析优先级、环境变量总表、allowedRoots、启动与健康检查、OAuth 持久化 | 阶段 4–5，或要改配置/查变量时 |
| `references/chatgpt-connector.md` | 建连接器完整步骤与字段、成功判据、在对话里使用、browser-harness 自动化要点、收尾 | 阶段 6，或连接器报错时 |
| `references/troubleshooting.md` | 容错设计（五原则/错误分级/阶段恢复表/降级/回滚）、故障速查表、已证伪的伪根因 | **出任何问题时先读这个** |

## 外部参考

- DevSpace 官方 README / Setup / Gotchas / Security / Config（仓库路径 `Waishnav/devspace`，`docs/` 下）
- OpenAI 连接器文档：`developers.openai.com/plugins/deploy/connect-chatgpt`
- Tailscale Funnel：`tailscale.com/kb/1247/funnel-serve-use-cases`
