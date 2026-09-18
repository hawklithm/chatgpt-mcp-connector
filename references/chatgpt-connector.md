# ChatGPT 连接器与授权（阶段 6）

> 阶段 6 = 在 ChatGPT 建自定义连接器并完成 OAuth 授权。
> 另含 **browser-harness 自动化要点**（仅在用户明确要求自动化时用）。
> 主流程见 SKILL.md；本文件是完整细节。

> 🙋 **需要用户操作 —— 整个阶段 6 都必须人工完成**：登录 ChatGPT、开开发者模式、
> 在插件页建连接器、在授权页填 Owner password，全部在浏览器里。
> **agent 能做的是「准备好该填的值 + 逐步引导 + 事后用日志验证」**，
> 而不是自己提交表单（除非用户明确要求走浏览器自动化，那种情况见文末要点）。

## ⚠️ 铁律：Settings 只开开发者模式，连接器必须在「插件」页建

这两处表单字段长得**一模一样**（名称 / 描述 / URL / OAuth 三选项），走错了提交就报
`Something went wrong. If this issue persists please contact us through our help center.`
**绝大多数这个报错都是入口走错**，不是服务端问题。

## 完整步骤

1. 设置 → **账户安全与登录** → 打开 **开发者模式**（只需一次）
2. 打开 `https://chatgpt.com/plugins`
3. 点右上角 **`创建应用`** 按钮（aria-label=`创建应用`；1904 宽视口下约 `(1448, 135)`）
4. 提交后 URL 变为
   `https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins`
   —— 这个深链接可当作「直接打开新插件弹窗」的快捷入口
5. 「新插件」弹窗填表：

   | 字段 | 值 |
   | --- | --- |
   | `input[name=custom-connector-name]` | 自定义名字，如 `DevSpace` |
   | `input[name=custom-connector-description]` | 任意描述（可选） |
   | 连接方式 | 选 **`服务器 URL`**（另一个是 `隧道`） |
   | `input[name=custom-connector-url]` | `https://<域名>/mcp`，**必须带 `/mcp`** |
   | 身份验证 `select` | 保持 **`OAUTH`**（另两个：`无身份验证` / `混合`） |
   | checkbox | **必须勾选「我了解并希望继续」，否则 `创建` 永远 disabled** |

6. **可视信号**：填完 URL 后，`高级 OAuth 设置` 按钮文案从
   「输入有效的 MCP 服务器 URL 以查看已发现的 OAuth 设置」（disabled）
   变成「**查看已发现的 OAuth 设置**」（enabled）→ OAuth 发现成功。
7. 点 `创建` → **等 ≥6 秒**（提交异步，弹窗随后才关；等不够会误判为失败）
8. ChatGPT 自动跳 `/authorize?...&redirect_uri=https://chatgpt.com/connector/oauth/...`
   → 填 **Owner password**（`~/.devspace/auth.json` 的 `ownerToken`，字段名 `owner_token`）
   → 点 `Authorize DevSpace`

   > 🙋 **需要用户操作**：这一步的密码由**用户在浏览器页面里亲自填**。
   > **绝对不要让用户把 Owner password 贴进聊天/日志里** —— 需要时只告诉他「去 `~/.devspace/auth.json` 里看」。

9. 302 回跳 `https://chatgpt.com/connector/oauth/<id>?code=...&state=...` → 完成

## 成功判据（服务端日志，`userAgent` 是关键区分字段）

```
POST /mcp  → 401   Python/3.14 aiohttp       ← OpenAI 后端预检，读 WWW-Authenticate
GET  /     → 200   aiohttp                   ← oauth-protected-resource/mcp
GET  /     → 200   aiohttp                   ← oauth-authorization-server
POST /     → 201   aiohttp                   ← ★ DCR 动态客户端注册成功（219 字节）
POST /     → 302   Chrome                    ← ★ Owner 密码通过，带 code 重定向
POST /mcp  → 200   openai-mcp/1.0.0          ← ★ 正式客户端建立 MCP 会话
mcp_session_created  sessionIdPrefix ...
```

**最终判据：`userAgent: openai-mcp/1.0.0` + `200` + `mcp_session_created`。**
随后会出现真实业务日志，例如：

```
{"event":"tool_call","tool":"read","workspaceId":"ws_a16dfaff82","path":"crates/core/src/...","success":true}
```

**认这个才是真通了** —— 说明 ChatGPT 真的在读写你本机文件。

UI 侧：插件页「已安装」出现 `DevSpace`，详情页显示 `在聊天中试用 / 版本 x.y.z`。

> 日志中间件的 `path` 字段对 well-known 路由记录**不准**（返回 200 的正确 JSON 却记成 `GET /`），
> 排查时别只信这个字段。

## 在对话里用它

新开一个对话，从工具菜单挂上 DevSpace，然后给**绝对路径**（别让它猜）：

```
用 DevSpace 打开本地工作区：D:\projects\my-app\<项目名>          （Windows）
用 DevSpace 打开本地工作区：/home/you/projects/my-app/<项目名>    （macOS / Linux）

只读，不要改文件、不要跑有副作用的命令。
先读根目录的 AGENTS.md / CLAUDE.md（如果存在），然后告诉我：
1. 技术栈；2. 启动与测试命令；3. 当前 git 状态；4. 你实际读了哪些文件。
```

> 路径必须是**本机原生写法**：Windows 用反斜杠（`D:\...`），macOS / Linux 用正斜杠（`/home/...`）。

同一会话内 `open_workspace` 返回的 `workspace_id` 要一直复用；
白名单内可以自由切换/打开多个 workspace（各有独立 `workspace_id`）。

## 浏览器自动化要点（browser-harness）

仅在用户明确要求自动提交表单时使用（正常流程应由用户手动操作）。

- **每次 `browser-harness` 调用都会重置当前标签页** → 每个脚本开头必须重新选标签：

  ```python
  for t in list_tabs():
      if <匹配条件>: switch_tab(t["targetId"]); break
  ```

  注意授权流程会把标签页从 `chatgpt.com` **导航到隧道域名**，
  所以匹配条件不能写死 `chatgpt.com`，否则会误操作成别的标签页。
- 定位元素优先用 DOM 枚举（`js(...)` 扫 `button,a,[role=button]` 拿 `getBoundingClientRect`），
  比 AX 树稳（`DOM.getBoxModel` 用 AX 给的 `backendNodeId` 会报 `Invalid parameters`）。
- **填 React 受控输入**：`el.value = v` 无效，必须用原生 setter + 派发事件：

  ```js
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, v);
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  ```

- **点击用坐标点击 `click_at_xy()`，不要用 JS `.click()`** —— JS 点击对 ChatGPT 的 React
  按钮经常无效；坐标点击能正确触发（checkbox 勾选、提交都能 work）。
- 坐标超出视口（`y > ph`）会点空：先 `el.scrollIntoView({block:'center'})` 再重新量。
- 直接 `goto_url` 到 SPA 详情页（`/plugins/plugin_xxx`）渲染不出内容，
  必须回到列表页用 `click_at_xy` 走客户端路由。
- 想确认前端到底发没发请求，可给页面 `window.fetch` 打桩记录到 `window.__netlog`，
  比只看服务端日志更快定位。

## 收尾

- **`devspace serve` 必须常驻**；agent 会话结束后需在终端手动起。
  开机自启按平台选：Windows 用任务计划程序 / `nssm`，macOS 用 `launchd`（`~/Library/LaunchAgents/*.plist`），
  Linux 用 `systemd`（user 或 system unit）。启动命令一律指向**绝对路径的 `dist/cli.js`**：
  `node "$(npm root -g)/@waishnav/devspace/dist/cli.js" serve`（三平台通用）。
- 用完关公网入口：`tailscale funnel reset`。
- ChatGPT 侧：连接器详情页可以 **Refresh** 重新拉取工具列表；改完 URL 记得 Refresh + 新开对话。
- 插件建好了但新对话里看不到工具 → 打开连接详情 → **Refresh** → 再新开一个对话。
