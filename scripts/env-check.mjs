#!/usr/bin/env node
/**
 * 环境自检 + 一键补齐（DevSpace × ChatGPT MCP 接入的前置依赖）
 *
 * 用法：
 *   node env-check.mjs                # 只读自检，打印结果 + 缺失项的安装命令
 *   node env-check.mjs --install      # 自检后，用系统包管理器安装缺失项
 *   node env-check.mjs --json         # 机器可读输出（给 agent 解析）
 *   node env-check.mjs --only node,git  # 配合 --install，只装指定项
 *
 * 检查项：Node / npm / Git / Bash / Tailscale / DevSpace / better-sqlite3 / 包管理器
 *
 * ⚠️ 安全约定：默认【不安装任何东西】。只有显式传 --install 才会执行安装命令。
 *    在 agent 场景里，调用方应先跑一次自检、把结果给用户看、征得同意后再加 --install。
 *
 * 容错约定：
 *   - 每项检查独立 try/catch：单项炸掉不影响其他项，也不影响整体出报告。
 *   - 所有外部命令**带超时**（探测 15s / 安装 10min）——挂住的命令会拖死整个自检。
 *   - 只对可恢复失败重试（网络抖动）；ENOENT / EACCES 直接放弃，不浪费时间。
 *   - --install 时单项失败**不中断整轮**，最后统一汇总成功/失败/需手动。
 *   - 退出码反映**自检时**的状态；刚装完但 PATH 未刷新仍返回 1（不报假绿）。
 *
 * 人工介入提醒：
 *   - 部分环节**脚本代替不了**（典型：`tailscale up` 要用户去浏览器授权）。
 *     检测到这类情况时会置 `needsUserAction`，并在最后单独汇总一次 🙋 清单，
 *     方便 agent 明确「该停下来让用户做什么」，而不是自己干等。
 *
 * 退出码：0 = 全部就绪；1 = 有缺失项；2 = 脚本自身出错
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// ── 容错：超时上限 ──
// 外部命令挂住会拖死整个自检（agent 场景下表现为任务永不返回）。
// 实测 winget 首次使用、tailscale 未登录、损坏的 bash shim 都可能卡住等输入。
const TIMEOUT_PROBE = 15000; // 版本探测这类快命令
const TIMEOUT_INSTALL = 600000; // npm install / rebuild 可能跑几分钟

const args = process.argv.slice(2);
const WANT_INSTALL = args.includes('--install');
const WANT_JSON = args.includes('--json');
const onlyIdx = args.indexOf('--only');
const ONLY = onlyIdx >= 0 && args[onlyIdx + 1] ? args[onlyIdx + 1].split(',').map((s) => s.trim()) : null;

// ─────────────────────────── 工具函数 ───────────────────────────

/**
 * 执行外部命令（带超时 + 可选重试）。
 *
 * Windows 上 Node 不允许直接 spawn .cmd/.bat（会 EINVAL），必须走 shell；
 * 而 shell 模式下 Node 只是把 cmd + args 用空格拼起来、**不会给带空格的路径加引号**，
 * 于是 "C:\Program Files\...\npm.cmd" 会被从空格处截断。所以这里手动加引号。
 *
 * 容错约定：只对「网络抖动 / 临时占用」这类可恢复失败重试；
 * ENOENT（命令不存在）、EACCES（权限拒绝）重试纯属浪费，直接跳出。
 *
 * @param {string} cmd
 * @param {string[]} [cmdArgs]
 * @param {{timeout?: number, retries?: number}} [opts]
 */
function tryExec(cmd, cmdArgs = ['--version'], opts = {}) {
  const timeout = opts.timeout ?? TIMEOUT_PROBE;
  const retries = opts.retries ?? 0;
  const needsShell = IS_WIN && /\.(cmd|bat)$/i.test(cmd);
  const launch = needsShell ? `"${cmd}"` : cmd;

  let last = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const out = execFileSync(launch, cmdArgs, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: needsShell,
        timeout,
        killSignal: 'SIGKILL',
      });
      return { ok: true, out: String(out).trim(), attempts: attempt + 1 };
    } catch (e) {
      last = e;
      if (e?.code === 'ENOENT' || e?.code === 'EACCES' || e?.code === 'EPERM') break;
    }
  }
  const timedOut = last?.code === 'ETIMEDOUT' || last?.killed === true || last?.signal === 'SIGKILL';
  return { ok: false, err: last, timedOut, attempts: retries + 1 };
}

/** 把 execSync 抛出的错误压成一行可读文本（用于日志/JSON，避免整段堆栈）。 */
function errLine(e) {
  if (!e) return '(无错误对象)';
  if (e.code === 'ETIMEDOUT' || e.killed) return `超时（超过 ${TIMEOUT_PROBE}ms 未返回）`;
  const raw = e.stderr ? String(e.stderr) : String(e.message || e);
  return raw.split('\n').map((s) => s.trim()).filter(Boolean)[0]?.slice(0, 200) || '(无输出)';
}

/**
 * 定位 npm。
 * 必须优先取「当前 Node 同目录」的 npm —— 否则 PATH 里若混有其它 Node 发行版
 * （如某工具自带的运行时），会拿到那个 npm 及其 global root，导致 DevSpace 定位错包。
 */
function npmBin() {
  const adjacent = join(dirname(process.execPath), IS_WIN ? 'npm.cmd' : 'npm');
  if (existsSync(adjacent)) return adjacent;
  return which(IS_WIN ? 'npm.cmd' : 'npm') || which('npm');
}

/** 跨平台 which：在 PATH 里找可执行文件，返回绝对路径。 */
function which(name) {
  const pathEnv = process.env.PATH || '';
  const exts = IS_WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [''];
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = join(dir, name + ext);
      try {
        if (existsSync(p) && statSync(p).isFile()) return p;
      } catch {
        /* 忽略无权限的目录 */
      }
    }
  }
  return null;
}

/** 在候选固定路径里找第一个存在的文件。 */
function firstExisting(paths) {
  for (const p of paths) if (p && existsSync(p)) return p;
  return null;
}

function parseVersion(str) {
  const m = String(str || '').match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return m ? { major: +m[1], minor: +m[2], patch: +(m[3] || 0) } : null;
}

// ─────────────────────────── 各检查项 ───────────────────────────

/** Node：README 要求 >=22.19 <27；cli.js 的 assertSupportedNode 实际为 >=20.12 <27 */
function checkNode() {
  const v = process.versions.node;
  const p = parseVersion(v);
  const item = { id: 'node', name: 'Node.js', required: '>=20.12 <27（README 写 >=22.19 <27）', found: v, path: process.execPath };
  if (!p) { item.status = 'fail'; item.note = '无法解析版本'; return item; }
  if (p.major >= 27) {
    item.status = 'fail';
    item.note = `版本过高（需 <27）。当前 ${v}`;
  } else if (p.major < 20 || (p.major === 20 && p.minor < 12)) {
    item.status = 'fail';
    item.note = `版本过低（需 >=20.12）。当前 ${v}`;
  } else if (p.major === 22 && p.minor >= 19) {
    item.status = 'ok';
    item.note = '符合 README 推荐区间';
  } else if (p.major === 24) {
    item.status = 'ok';
    item.note = '可用（现为 LTS 线）';
  } else {
    item.status = 'warn';
    item.note = `可用但偏旧/非推荐线，建议 22.19+ 或 24 LTS。当前 ${v}`;
  }
  return item;
}

/** npm */
function checkNpm() {
  const bin = npmBin();
  const r = tryExec(bin || 'npm', ['--version']);
  const item = { id: 'npm', name: 'npm', required: '随 Node 安装', found: r.ok ? r.out.split('\n')[0] : null, path: bin };
  if (r.ok) { item.status = 'ok'; }
  else {
    item.status = 'fail';
    item.note = bin
      ? '找到了 npm 但执行失败（Windows 上 .cmd 需要 shell，已处理；仍失败则重装 Node）'
      : 'npm 不在 PATH（重装 Node 或修复 PATH）';
  }
  return item;
}

/** Git —— DevSpace 的 worktree 模式依赖；Windows 上 Git 同时提供 Git Bash */
function checkGit() {
  const bin = which('git') || which('git.exe');
  const r = tryExec(bin || 'git', ['--version']);
  const item = { id: 'git', name: 'Git', required: '任意（worktree 模式必需）', found: r.ok ? r.out : null, path: bin };
  if (r.ok) { item.status = 'ok'; }
  else { item.status = 'fail'; item.note = '未找到 git'; }
  return item;
}

/** Bash —— DevSpace 执行 shell 命令的硬性要求（纯 PowerShell / cmd 不支持） */
function checkBash() {
  const item = { id: 'bash', name: 'Bash', required: 'Bash 兼容 shell（Git Bash / WSL / MSYS2 / Cygwin）', found: null, path: null };

  const candidates = IS_WIN
    ? [
        // 常见 Git for Windows 安装位置（含自定义盘符）
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Program Files\\Git\\bin\\bash.exe',
        process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
        // MSYS2 / Cygwin
        'C:\\msys64\\usr\\bin\\bash.exe',
        'C:\\cygwin64\\bin\\bash.exe',
        // WSL 入口
        'C:\\Windows\\System32\\bash.exe',
      ].filter(Boolean)
    : ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash'];

  // 分档：数值越小越推荐。Git Bash 是 Windows 上最省事的原生方案。
  const classify = (p) => {
    const l = p.toLowerCase().replace(/\//g, '\\');
    if (l.includes('\\git\\bin\\bash')) return { flavor: 'Git Bash', rank: 1 };
    if (l.includes('msys64')) return { flavor: 'MSYS2', rank: 2 };
    if (l.includes('cygwin')) return { flavor: 'Cygwin', rank: 3 };
    if (l.includes('system32\\bash') || l.includes('\\wsl')) return { flavor: 'WSL（Windows Subsystem for Linux）', rank: 4, noExec: true };
    if (l.includes('portablegit')) return { flavor: 'PortableGit（某工具自带的副本）', rank: 9 };
    return { flavor: 'Bash', rank: 5 };
  };

  // 收集全部候选：PATH 里的 + 固定路径里的（不提前 break，便于把选择权交给用户判断）
  const all = [];
  const fromPath = which('bash') || which('bash.exe');
  if (fromPath) all.push(fromPath);
  for (const c of candidates) if (existsSync(c) && !all.some((x) => x.toLowerCase() === c.toLowerCase())) all.push(c);

  if (all.length === 0) {
    item.status = 'fail';
    item.note = IS_WIN
      ? '未找到任何 Bash。DevSpace 无法执行 shell 命令 —— 装 Git for Windows 即可同时获得 Git + Git Bash'
      : '未找到 bash（极少见，检查 /bin/bash）';
    return item;
  }

  const detailed = all
    .map((p) => {
      const { flavor, rank, noExec } = classify(p);
      let version = null;
      if (noExec) {
        // WSL 入口不要真的去执行：它会拉起 wsl.exe，可能被安全策略拦截，且代价高
        version = '（仅检测到入口，未执行）';
      } else {
        const r = tryExec(p, ['--version']);
        version = r.ok ? r.out.split('\n')[0] : '（执行失败）';
      }
      return { path: p, flavor, rank, version, noExec: !!noExec };
    })
    .sort((a, b) => a.rank - b.rank);

  const best = detailed[0];
  item.candidates = detailed;
  item.path = best.path;
  item.flavor = best.flavor;
  item.found = best.version;

  if (best.flavor.startsWith('PortableGit')) {
    item.status = 'warn';
    item.note = `只找到 ${best.flavor}。DevSpace 未必能稳定调用 —— 建议另装 Git for Windows`;
  } else if (best.noExec) {
    item.status = 'ok';
    item.note = '只找到 WSL。WSL 受支持，但 Git Bash 是 Windows 上更简单的原生方案';
  } else {
    item.status = 'ok';
    item.note = best.flavor;
  }
  if (detailed.length > 1) item.note += `；共发现 ${detailed.length} 个 Bash（见下方列表）`;
  return item;
}

/** Tailscale —— 提供公网 HTTPS 隧道（ChatGPT 够不到 127.0.0.1） */
function checkTailscale() {
  const candidates = IS_WIN
    ? [join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe'), 'C:\\Program Files (x86)\\Tailscale\\tailscale.exe']
    : ['/usr/bin/tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
  const bin = which('tailscale') || which('tailscale.exe') || firstExisting(candidates);
  const item = { id: 'tailscale', name: 'Tailscale', required: '>=1.38.3（1.52 起 CLI 语法变更，建议用新版）', found: null, path: bin };
  if (!bin) {
    item.status = 'fail';
    item.note = '未找到 tailscale CLI（公网隧道必需）';
    return item;
  }
  const r = tryExec(bin, ['version']);
  if (!r.ok) { item.status = 'fail'; item.note = '找到文件但无法执行'; return item; }
  const line = r.out.split('\n')[0].trim();
  item.found = line;
  const p = parseVersion(line);

  let status = 'ok';
  let note = '';
  if (p && (p.major < 1 || (p.major === 1 && p.minor < 38))) {
    status = 'fail';
    note = '版本过低（需 >=1.38.3）';
  } else if (p && p.major === 1 && p.minor < 52) {
    status = 'warn';
    note = '版本 <1.52，serve/funnel 用的是旧 CLI 语法，建议升级';
  }

  // ── 登录态：装了 ≠ 能用 ──
  // `tailscale up` 必须由人去浏览器完成授权，这是整条流程里**第一个必须人工介入**的点。
  // 提前暴露出来，免得 agent 一路跑到开隧道才发现卡在未登录。
  const st = tryExec(bin, ['status', '--json'], { timeout: 10000 });
  let backend = null;
  if (st.ok) {
    try { backend = JSON.parse(st.out).BackendState ?? null; } catch { backend = null; }
  }
  item.backend = backend;

  if (status !== 'fail') {
    if (!backend) {
      status = 'warn';
      note = '读不到运行状态 —— Tailscale 客户端/服务可能没启动';
      item.needsUserAction = '启动 Tailscale（Windows 托盘图标）后执行 `tailscale up`，在浏览器里完成授权';
    } else if (backend !== 'Running') {
      status = 'warn';
      note = `已安装但未登录（BackendState=${backend}）`;
      item.needsUserAction = '执行 `tailscale up` —— 它会打印一个链接，需要你用浏览器打开并完成登录授权';
    } else if (!note) {
      note = '已登录且运行中';
    }
  }

  item.status = status;
  if (note) item.note = note;
  return item;
}

/** DevSpace —— 通过全局 npm root 定位包，而不是靠 shim（shim 在 PATH 残缺时会算错路径） */
function checkDevspace() {
  const item = { id: 'devspace', name: 'DevSpace', required: '@waishnav/devspace', found: null, path: null };
  const npm = npmBin();
  if (!npm) {
    item.status = 'fail';
    item.note = '找不到 npm，先修好 Node/npm';
    return item;
  }
  let root = null;
  const rootRes = tryExec(npm, ['root', '-g']);
  if (!rootRes.ok) {
    item.status = 'fail';
    item.note = `无法执行 \`npm root -g\`：${errLine(rootRes.err)}`;
    return item;
  }
  root = rootRes.out;
  item.globalRoot = root;
  const pkgJson = join(root, '@waishnav', 'devspace', 'package.json');
  if (!existsSync(pkgJson)) {
    item.status = 'fail';
    item.note = `未安装（${root} 下没有 @waishnav/devspace）。安装：npm install -g @waishnav/devspace`;
    return item;
  }
  try {
    const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'));
    item.found = pkg.version;
    item.path = join(root, '@waishnav', 'devspace', 'dist', 'cli.js');
  } catch {
    item.status = 'warn';
    item.note = '找到包但 package.json 解析失败';
    return item;
  }
  item.status = 'ok';
  item.note = '已安装';
  // shim 可用性：POSIX shell 脚本版 shim 依赖 sed/dirname/uname，PATH 残缺时会算错路径
  if (IS_WIN) {
    if (!existsSync(join(root, '..', 'devspace.cmd')) && !which('devspace.cmd')) {
      item.note = '已安装，但未找到 devspace.cmd shim —— 调用时请直接用 `node <path>/dist/cli.js`';
    }
  }
  return item;
}

/** better-sqlite3 原生依赖 —— DevSpace 的状态存储依赖它 */
function checkSqlite(devspaceItem) {
  const item = { id: 'sqlite', name: 'better-sqlite3（DevSpace 原生依赖）', required: '可加载', found: null, path: null };
  if (!devspaceItem.path) { item.status = 'skip'; item.note = 'DevSpace 未安装，跳过'; return item; }
  try {
    const req = createRequire(join(devspaceItem.path, '..', '..', 'package.json'));
    req('better-sqlite3');
    item.status = 'ok';
    item.found = '可加载';
  } catch (e) {
    item.status = 'fail';
    item.found = '加载失败';
    item.note = `多半是原生依赖装在了别的 Node 运行时下。修复：npm rebuild better-sqlite3（${errLine(e)}）`;
  }
  return item;
}

/** 包管理器可用性 —— 决定用什么方式补齐依赖 */
function checkPkgManagers() {
  const out = {};
  if (IS_WIN) {
    const r = tryExec('winget', ['--version']);
    out.winget = r.ok ? r.out : null;
  } else if (IS_MAC) {
    const r = tryExec('brew', ['--version']);
    out.brew = r.ok ? r.out.split('\n')[0] : null;
  } else {
    for (const m of ['apt-get', 'dnf', 'yum', 'pacman', 'zypper', 'apk']) {
      const r = tryExec(m, ['--version']);
      if (r.ok) out[m] = r.out.split('\n')[0];
    }
  }
  return out;
}

// ─────────────────────────── 安装命令映射 ───────────────────────────

function installCommands(id, managers) {
  const cmds = [];

  const pick = (win, mac, linux) => {
    if (IS_WIN) return win ? [win] : [];
    if (IS_MAC) return mac ? [mac] : [];
    return linux ? [linux] : [];
  };

  if (id === 'node' || id === 'npm') {
    cmds.push(
      ...pick(
        'winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements',
        'brew install node@22 && brew link --overwrite --force node@22',
        'curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs   # Debian/Ubuntu\nsudo dnf install -y nodejs   # Fedora/RHEL\nsudo pacman -S --noconfirm nodejs npm   # Arch'
      )
    );
  }
  if (id === 'git') {
    cmds.push(
      ...pick(
        'winget install -e --id Git.Git --accept-package-agreements --accept-source-agreements',
        'brew install git',
        'sudo apt-get install -y git   # Debian/Ubuntu\nsudo dnf install -y git   # Fedora/RHEL\nsudo pacman -S --noconfirm git   # Arch'
      )
    );
  }
  if (id === 'bash') {
    cmds.push(
      ...pick(
        'winget install -e --id Git.Git --accept-package-agreements --accept-source-agreements   # Git for Windows 自带 Git Bash（推荐）\nwinget install -e --id Microsoft.WSL   # 或者装 WSL',
        'brew install bash',
        '# 一般已自带 bash；确认 /bin/bash 存在'
      )
    );
  }
  if (id === 'tailscale') {
    cmds.push(
      ...pick(
        'winget install -e --id Tailscale.Tailscale --accept-package-agreements --accept-source-agreements',
        'brew install --cask tailscale',
        'curl -fsSL https://tailscale.com/install.sh | sh'
      )
    );
  }
  if (id === 'devspace') {
    cmds.push('npm install -g @waishnav/devspace');
  }
  if (id === 'sqlite') {
    cmds.push('npm rebuild better-sqlite3');
  }
  return cmds;
}

/** 执行安装命令时，把命令名解析成真实可执行文件（Windows 上 `npm` 单独一个词跑不起来） */
function resolveExe(tok) {
  if (tok === 'npm' || tok === 'npm.cmd') return npmBin() || tok;
  return which(IS_WIN ? `${tok}.exe` : tok) || which(tok) || tok;
}

/** 某些项可以直接由本脚本执行（无需系统包管理器） */
function selfInstallable(id) {
  return id === 'devspace' || id === 'sqlite';
}

// ─────────────────────────── 主流程 ───────────────────────────

const managers = checkPkgManagers();
const nodeItem = checkNode();
const results = [nodeItem, checkNpm(), checkGit(), checkBash(), checkTailscale(), checkDevspace()];
results.push(checkSqlite(results[5]));

const bad = results.filter((r) => r.status === 'fail');
const warns = results.filter((r) => r.status === 'warn');

if (WANT_JSON) {
  console.log(JSON.stringify({ platform: process.platform, managers, results, missing: bad.map((b) => b.id) }, null, 2));
} else {
  console.log('=== 环境自检：DevSpace × ChatGPT MCP 接入前置依赖 ===\n');
  console.log(`平台: ${process.platform}  Node: ${process.versions.node}\n`);

  const icon = (s) => ({ ok: '[ok]  ', fail: '[缺失]', warn: '[警告]', skip: '[跳过]' })[s] || '[?]';
  for (const r of results) {
    console.log(`${icon(r.status)} ${r.name}${r.found ? `: ${r.found}` : ''}`);
    if (r.path) console.log(`        路径: ${r.path}`);
    console.log(`        要求: ${r.required}`);
    if (r.globalRoot) console.log(`        全局 root: ${r.globalRoot}`);
    if (r.note) console.log(`        说明: ${r.note}`);
    if (r.needsUserAction) console.log(`        🙋 需要你操作: ${r.needsUserAction}`);
    if (r.candidates) {
      console.log('        发现的 Bash:');
      r.candidates.forEach((c, i) => {
        console.log(`          ${i === 0 ? '★' : ' '} [${c.flavor}] ${c.path}`);
        console.log(`              ${c.version}`);
      });
    }
    console.log('');
  }

  console.log('--- 包管理器 ---');
  if (Object.keys(managers).length) {
    for (const [k, v] of Object.entries(managers)) console.log(`  [ok]   ${k} ${v}`);
  } else {
    console.log('  [缺失] 未找到可用的包管理器（winget / brew / apt 等），需要手动安装依赖');
  }

  // 把「必须人工介入」的点集中报一次 —— 这些脚本替不了，只能提醒用户。
  const manual = results.filter((r) => r.needsUserAction);
  if (manual.length) {
    console.log('\n🙋 以下步骤必须由你亲自完成（脚本代替不了，请先做掉再继续）:');
    for (const m of manual) console.log(`   - ${m.name}：${m.needsUserAction}`);
  }

  const needInstall = [...bad, ...warns.filter((w) => w.id === 'bash' || w.id === 'tailscale')];
  if (needInstall.length === 0 && bad.length === 0) {
    console.log('\n✅ 全部就绪，可以进入下一步：配置 DevSpace + 开隧道。');
  } else if (bad.length > 0) {
    console.log(`\n❌ 有 ${bad.length} 项缺失：${bad.map((b) => b.id).join(', ')}`);
    console.log('\n--- 安装命令 ---');
    for (const b of bad) {
      const cmds = installCommands(b.id, managers);
      console.log(`\n# ${b.name}`);
      if (cmds.length === 0) console.log('  （当前平台没有自动安装方案，请手动安装）');
      else cmds.forEach((c) => console.log('  ' + c));
    }
    if (!WANT_INSTALL) {
      console.log('\n提示：加 --install 让本脚本自动执行上面的命令（本脚本可自行安装的项：devspace、sqlite）。');
    }
  }
  if (warns.length) console.log(`\n⚠️  ${warns.length} 项警告：${warns.map((w) => w.id).join(', ')}`);

  if (WANT_INSTALL) {
    console.log('\n=== 开始安装 ===');
    const targets = (ONLY ? results.filter((r) => ONLY.includes(r.id)) : [...bad, ...warns])
      .filter((r) => r.status === 'fail' || r.status === 'warn');
    if (targets.length === 0) console.log('没有需要安装的项。');

    // 容错：单项失败不中断整轮 —— 继续装后面的，最后统一汇总。
    // 否则「Node 装失败」会连带把 Tailscale 也跳过，用户还得再跑一遍。
    const report = [];
    for (const t of targets) {
      const cmds = installCommands(t.id, managers);
      if (cmds.length === 0) { console.log(`\n[跳过] ${t.name}：无自动安装方案`); report.push({ id: t.id, how: '跳过', ok: null }); continue; }
      if (!selfInstallable(t.id) && IS_WIN && !managers.winget) {
        console.log(`\n[跳过] ${t.name}：没有 winget，无法自动安装`); report.push({ id: t.id, how: '跳过', ok: null }); continue;
      }
      for (const c of cmds) {
        // 含换行（多发行）、或含管道/重定向/sudo 的命令交给用户手动跑，避免 shell 语义不可控
        const isSingle = !c.includes('\n');
        const complex = /[|>&]/.test(c) || /\bsudo\b/.test(c);
        if (!isSingle || complex) {
          console.log(`\n[手动] ${t.name}（请自行执行）:\n  ${c}`);
          report.push({ id: t.id, how: '手动', ok: null });
          continue;
        }
        const parts = c.split(/\s+/);
        const exe = resolveExe(parts[0]);
        // 走网络的安装命令：给长超时 + 重试 1 次（registry 抖动很常见，重试成功率不错）
        const networked = /^(npm|winget|brew|pacman|dnf|yum|apt-get|zypper|apk)$/.test(parts[0]);
        console.log(`\n[执行] ${c}`);
        const r = tryExec(exe, parts.slice(1), {
          timeout: TIMEOUT_INSTALL,
          retries: networked ? 1 : 0,
        });
        if (r.ok) {
          console.log('  ' + (r.out.split('\n').slice(0, 6).join('\n') || '(完成)') + (r.attempts > 1 ? `\n  （第 ${r.attempts} 次尝试成功）` : ''));
          report.push({ id: t.id, how: '自动', ok: true });
        } else {
          console.log(`  失败: ${errLine(r.err)}`);
          report.push({ id: t.id, how: '自动', ok: false, msg: errLine(r.err) });
        }
      }
    }

    // ── 安装结果汇总 ──
    const autoOk = report.filter((x) => x.ok === true);
    const autoFail = report.filter((x) => x.ok === false);
    const manual = report.filter((x) => x.how === '手动');
    const skipped = report.filter((x) => x.how === '跳过');
    console.log('\n--- 安装结果汇总 ---');
    console.log(`  自动成功: ${autoOk.length ? autoOk.map((x) => x.id).join(', ') : '（无）'}`);
    console.log(`  自动失败: ${autoFail.length ? autoFail.map((x) => `${x.id}（${x.msg}）`).join('; ') : '（无）'}`);
    console.log(`  需手动  : ${manual.length ? [...new Set(manual.map((x) => x.id))].join(', ') : '（无）'}`);
    console.log(`  已跳过  : ${skipped.length ? [...new Set(skipped.map((x) => x.id))].join(', ') : '（无）'}`);

    if (autoFail.length) {
      console.log('\n失败项的处理建议：');
      for (const f of autoFail) {
        console.log(`  - ${f.id}: 先查网络/代理；已安装但环境变量没生效时，**新开终端**再试；`);
        console.log(`    仍失败就按上面的「安装命令」手动执行，然后再跑一次本脚本。`);
      }
    }

    console.log('\n⚠️  注意：用包管理器装完 Node/Git 后，**当前终端不会自动刷新 PATH** —— 本进程内看到的仍是旧环境。');
    console.log('   请**新开一个终端**（或重启工具）后重跑本脚本，才算真正确认装好。');
  }
}

// 退出码反映【自检时】的状态：本进程内依赖确实还不可用（PATH 未刷新），不能因为「刚装过」就报绿。
process.exit(bad.length > 0 ? 1 : 0);
