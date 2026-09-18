# 容错设计与故障排查

> 本文件回答两个问题：**出事之前怎么防**（容错设计）与 **出事之后怎么办**（故障速查）。
> 主流程见 SKILL.md。

下文用到的脚本目录变量（与 SKILL.md 一致）：

```bash
SK=~/.workbuddy/skills/chatgpt-mcp-connector/scripts
```

## 容错设计：先定原则，再看具体怎么坏

### 五条原则

| 原则 | 做法 | 落到本流程哪里 |
| --- | --- | --- |
| **幂等优先** | 任何一步都能安全重跑，不依赖「上次跑到哪」 | `env-check` 可反复跑；`bootstrap apply` 内容不变就不写盘 |
| **改前先备份** | 动文件前先留退路 | `apply` 自动写 `<文件>.bak`；`rollback` 可整文件回退 |
| **不留半成品** | 所有校验在写盘**之前**完成，失败就在写盘前退出 | URL 形态、`/mcp` 后缀、JSON 可解析性都先验完再落盘 |
| **坏了要能自证** | 给出「谁坏了、证据在哪、下一步做什么」 | 损坏配置另存 `.corrupt-<时间戳>`；先用 `doctor`/`check` 定位 |
| **该停就停** | 需要人登录/授权/点后台开关的步骤，明确交给用户 —— 不静默等待，也不代做 | 见 SKILL.md「🙋 需要用户亲自做的步骤」；脚本检测到未登录会打 🙋 并在末尾汇总 |

### 错误分级：先判断该不该救

| 级别 | 典型现象 | 处置 |
| --- | --- | --- |
| **致命（必须停）** | Node 版本超出 `<27`；`config.json` / `auth.json` 损坏；`publicBaseUrl` 非法 | 停下修根源。**不要**用 `--force` 去掩盖 |
| **可恢复（重试）** | `npm install` 网络抖动、winget 源超时、Funnel 首次启用等后台批准 | 重试 1–2 次；仍失败改手动执行 |
| **可降级（绕开）** | Tailscale Funnel 用不了（没开 MagicDNS / 组织策略禁用 / 版本太老） | 换临时隧道（见下），用 `DEVSPACE_PUBLIC_BASE_URL` 注入 |
| **纯噪音（忽略）** | `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`；无 `/mcp` 后缀的 well-known 404；日志 `path` 字段记成 `GET /` | **不要修**。已实测不影响功能，为它搭反向代理纯属浪费时间 |

### 每阶段的前置检查 / 失败分支 / 恢复动作

| 阶段 | 前置检查 | 常见失败 | 恢复动作 |
| --- | --- | --- | --- |
| 0 环境 | `env-check` 报全绿 | 装完仍找不到命令 | **新开终端**刷新 PATH，再重跑 `env-check` |
| 1 DevSpace | `devspace -v` 能输出版本 | `Cannot find module ...dist\cli.js`（shim 依赖 `sed`/`dirname`，PATH 残缺时算错路径） | 用绝对路径直连 `dist/cli.js`，或走 `npx` |
| 2 Tailscale | `tailscale status` 有 Self | 未登录 / 守护进程没起 | `tailscale up`；Windows 上 CLI 不在 PATH，用绝对路径 `C:\Program Files\Tailscale\tailscale.exe` |
| 3 Funnel | `funnel status` 有 `proxy` 行 | MagicDNS 没开；节点未批准 funnel 属性 | 后台开 MagicDNS / 点终端给的批准链接，再 `funnel --bg <port>` |
| 4 配置 | `bootstrap check` 无 `[FAIL]` | JSON 损坏 | 脚本会**拒绝写盘**并另存 `.corrupt-*`；人工修好后重跑，或 `--force` 重建 |
| 5 serve | 启动日志 `allowed roots:` 符合预期 | 端口被占；非 TTY 下缺配置文件直接退出 | 换 `--port`；补齐 `config.json` + `auth.json`（或给 `DEVSPACE_OAUTH_OWNER_TOKEN`） |
| 6 连接器 | 公网 `/healthz` 200 且 `/mcp` 401 | `Something went wrong...` | 九成是入口走错（见 `references/chatgpt-connector.md` 铁律）；先确认隧道域名没变 |

### 降级路径：Funnel 用不了时

ChatGPT 只需要「一个公网 HTTPS origin」。Funnel 只是其中一种实现，可替换成任意临时隧道：

```bash
cloudflared tunnel --url http://127.0.0.1:7676   # 会打印一个 https://xxx.trycloudflare.com
# 拿到 URL 后注入（官方 help 里的用法）：
DEVSPACE_PUBLIC_BASE_URL=https://xxx.trycloudflare.com devspace serve
```

临时隧道**每次重启换域名** → 换了就要 `devspace config set publicBaseUrl <新origin>`（或用环境变量）
→ **重启 serve** → 回 ChatGPT 插件页 Refresh。
`allowedHosts` 会自动跟着 `publicBaseUrl` 推导，不用另配。

### 恢复与回滚

```bash
node $SK/devspace-bootstrap.mjs rollback            # config.json + auth.json 都从 .bak 恢复
node $SK/devspace-bootstrap.mjs rollback --config   # 只回滚配置
tailscale funnel reset                              # 关掉公网入口
```

回滚前会把当前文件另存为 `.pre-rollback`，所以**回滚本身也可再回滚**。
产物都在 `~/.devspace/`：`config.json` / `auth.json` 及其 `.bak` / `.corrupt-*` / `.pre-rollback`。

> **要不要用 `--force`？** 只有当你确认「旧配置已不可用、宁可重建」时才用。
> 它会丢弃损坏文件里的内容（虽然已另存），作用在 `auth.json` 上意味着**生成新的 Owner password**，
> 需要在 ChatGPT 里重新授权一次。

## 故障速查表

| 现象 | 大概率原因 | 处理 |
| --- | --- | --- |
| `tailscale up` 一直挂着 / 反复跑也登录不上 | 它在等用户去浏览器点授权链接 | **🙋 让用户打开那个链接完成登录**，别反复重跑命令 |
| `tailscale status` 没有 Self | 还没登录，或 Tailscale 服务没运行 | 🙋 让用户 `tailscale up`；Windows 上确认托盘图标在运行 |
| `Something went wrong...` | **① 在「设置」里建连接器（入口错）** ② 隧道没起/域名变了 ③ 提交后没等够 6 秒 | 改用 `chatgpt.com/plugins` → 右上角 `创建应用` |
| `does not implement OAuth` | ① 连接器是隧道配好之前建的（ChatGPT 侧缓存了失败预检）② 隧道没起 | 删掉重建；先跑通 `/healthz` |
| 服务端日志**完全没有** ChatGPT 的请求 | UI/入口/缓存问题，请求没发出来 | 查 UI 路径，**别在服务端瞎改** |
| `invalid_client` | 1.0.8 上不该出现；出现说明 SQLite 里没有这个 client | 查 `oauth_clients` 表；重建连接器 |
| 公网 `/mcp` 返回 **404** 而不是 401 | 用了 `--set-path=/mcp`，路径被剥掉了 | 重跑 `tailscale funnel --bg <port>`（代理整个端口） |
| 公网 `/healthz` 失败、本地成功 | 隧道/DNS/证书问题；Tailscale 版本过老 | 升级 Tailscale，重跑 funnel，`funnel status` 逐层查 |
| `Path is outside allowed roots` | 传的路径不在白名单内 | 见 `references/devspace-config.md`「换可访问目录」 |
| 隧道域名变了 | 临时隧道每次换 URL | `devspace config set publicBaseUrl <新origin>` 或用 `DEVSPACE_PUBLIC_BASE_URL`，然后重启 + 在插件页 Refresh |
| `devspace` 命令找不到 / `Cannot find module ...dist\cli.js` | shim 依赖 `sed`/`dirname`/`uname`，PATH 残缺的 shell 里会算错 | 用 `npx`，或绝对路径直连 `dist/cli.js` |
| `better-sqlite3` 加载失败 | 原生依赖装在了别的 Node 运行时下 | `npm rebuild better-sqlite3` |
| Node 版本超出 `<27` 区间 | 装成了 current（26.x 已逼近上限）或版本过老 | `winget install -e --id OpenJS.NodeJS.LTS`，`node -v` 确认 |
| `'C:\Program' 不是内部或外部命令` | Windows 上 shell 模式 spawn 没给含空格路径加引号 | 见 `references/env-setup.md`「装完之后的两个坑」第 2 条 |
| 找不到 Bash / 只找到 PortableGit | 没装 Git for Windows | `winget install -e --id Git.Git`；`env-check` 会列出全部候选并标推荐项 |
| 装完依赖但命令仍找不到 | 当前终端 PATH 是旧的 | **新开一个终端**（或重启工具），再重跑 `env-check` |
| `winget` 不存在 | 系统太老或缺「应用安装程序」 | 从 Microsoft Store 装 App Installer；或按 `references/env-setup.md` 的表格手动下载 |
| `config.json` / `auth.json` 损坏或被截断 | 手改时写错（尾逗号、漏右括号），或写入过程被中断 | 脚本会**拒绝写盘**并另存 `.corrupt-*`。人工修好后重跑，或 `apply --force` 重建 |
| `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` 刷 stderr | Express `trust proxy` 未开，express-rate-limit 校验告警 | **非致命**，只出现在 OAuth 端点流量上（实测日常 `tool_call` 不触发）。想消掉设 `DEVSPACE_TRUST_PROXY=true`（但会让限流键改用 XFF，隧道下可被伪造，自行权衡） |
| 插件建好了，但新对话里看不到工具 | 需要手动在对话工具菜单里挂上 | 打开连接详情 → **Refresh** → 再新开一个对话 |

## 已证伪的伪根因：不要为 well-known 404 加反向代理

`/.well-known/openid-configuration`、`/.well-known/oauth-protected-resource`（**无 `/mcp` 后缀**）、
`/.well-known/oauth-authorization-server/mcp` 确实返回 **404**，
但 ChatGPT 探到 404 **照样继续走 DCR 并成功**。这些 404 **不影响**连接。
不要为此搭路径重写代理，纯属浪费时间。
