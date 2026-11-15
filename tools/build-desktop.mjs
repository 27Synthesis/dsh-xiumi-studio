#!/usr/bin/env node
/**
 * 组装桌面 exe（不打 npm 包：直接复用本机已有的 Electron 运行时）。
 *
 *   node tools/build-desktop.mjs [--runtime "D:/DSH 工作区"] [--out desktop/dist] [--app-only]
 *
 * 产物布局（Electron 认的就是它）：
 *   desktop/dist/dsh-xiumi.exe          ← 运行时里的 exe，改个名
 *   desktop/dist/*.dll|*.pak|locales/   ← 运行时原样拷过来（不含它自己的 resources/）
 *   desktop/dist/resources/app/
 *       package.json                    ← main 指向 shell/main.js
 *       shell/                          ← desktop/app/*（主进程 + http 服务 + 配置）
 *       host/  client/                  ← 插件仓库里的那一份（不复制业务代码，只是拷文件）
 *
 * 为什么不用 electron-builder：本机没有 npm 依赖、下载也可能被墙（PLAN-R2 风险 2）。
 * 运行时的 resources/app.asar 是 DSH 自己的，绝不碰；我们只往 resources/app/ 里写自己的壳。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function arg(name, fallback) {
  const argv = process.argv.slice(2);
  const eq = argv.find((a) => a.startsWith('--' + name + '='));
  if (eq) return eq.slice(eq.indexOf('=') + 1);
  const i = argv.indexOf('--' + name);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return fallback;
}
const flag = (name) => process.argv.slice(2).includes('--' + name);

const runtimeDir = path.resolve(arg('runtime', 'D:/DSH 工作区'));
const outDir = path.resolve(arg('out', path.join(ROOT, 'desktop', 'dist')));
const appOnly = flag('app-only');
const EXE_SRC = 'DeepSeek Harness.exe';
const EXE_DST = 'dsh-xiumi.exe';
const SKIP_RUNTIME = new Set(['resources', 'Uninstall DeepSeek Harness.exe', 'version', '.DS_Store', 'entry.json']);


/**
 * 手搓一个 asar（不引 npm 依赖）。Electron 的 asar 就是：
 *   [uint32 = 4][uint32 = 头长度][JSON 头，4 字节对齐][文件内容顺次拼接]
 * 头里每个文件记 { size, offset }（offset 从内容区开头算）。
 * 有些 Electron 构建被 electron-builder 打开了「只从 asar 加载」的 fuse，
 * 那时 resources/app 目录会被无视，必须给 asar。
 */
function buildAsar(appDir, outFile) {
  const chunks = [];
  let offset = 0;
  const header = { files: {} };

  function nodeFor(parts) {
    let node = header.files;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      if (!node[key]) node[key] = { files: {} };
      node = node[key].files;
    }
    return node;
  }

  function walk(dir, parts) {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) {
        nodeFor([...parts, name])[name] = { files: {} };
        walk(abs, [...parts, name]);
      } else {
        const data = fs.readFileSync(abs);
        nodeFor([...parts, name])[name] = { size: data.length, offset: String(offset) };
        chunks.push(data);
        offset += data.length;
      }
    }
  }
  walk(appDir, []);

  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const pad = (4 - (json.length % 4)) % 4;
  const headerBuf = Buffer.concat([json, Buffer.alloc(pad)]);
  const sizes = Buffer.alloc(8);
  sizes.writeUInt32LE(4, 0);
  sizes.writeUInt32LE(headerBuf.length, 4);
  const out = Buffer.concat([sizes, headerBuf, ...chunks]);
  fs.writeFileSync(outFile, out);
  return { bytes: out.length, files: chunks.length };
}

function say(msg) {
  console.log('[build] ' + msg);
}

if (!fs.existsSync(path.join(runtimeDir, EXE_SRC))) {
  console.error('[build] 运行时里找不到 ' + EXE_SRC + '：' + runtimeDir);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

if (!appOnly) {
  say('从 ' + runtimeDir + ' 拷运行时（不含 resources/）');
  let copied = 0;
  for (const name of fs.readdirSync(runtimeDir)) {
    if (SKIP_RUNTIME.has(name)) continue;
    const src = path.join(runtimeDir, name);
    const dst = path.join(outDir, name === EXE_SRC ? EXE_DST : name);
    fs.cpSync(src, dst, { recursive: true, force: true });
    copied++;
  }
  say('运行时 ' + copied + ' 项就位；electron ' + (fs.existsSync(path.join(runtimeDir, 'version')) ? fs.readFileSync(path.join(runtimeDir, 'version'), 'utf8').trim() : '?'));
}

const appDir = path.join(outDir, 'resources', 'app');
fs.mkdirSync(appDir, { recursive: true });
// 只清我们自己的壳，绝不动 resources/ 里别的东西
for (const name of ['shell', 'host', 'client']) {
  fs.rmSync(path.join(appDir, name), { recursive: true, force: true });
}
fs.cpSync(path.join(ROOT, 'desktop', 'app'), path.join(appDir, 'shell'), { recursive: true });
fs.cpSync(path.join(ROOT, 'host'), path.join(appDir, 'host'), { recursive: true });
fs.cpSync(path.join(ROOT, 'client'), path.join(appDir, 'client'), { recursive: true });

const desktopPkg = {
  name: 'dsh-xiumi-desktop',
  productName: '秀米工作台',
  version: pkg.version || '0.1.0',
  description: pkg.description || '秀米图文台 · 桌面版',
  main: 'shell/main.js',
  private: true,
};
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(desktopPkg, null, 2) + '\n', 'utf8');

// 图标：desktop/build/icon.ico 由 tools/make-icon.py 生成（多尺寸 256…16）。
// 一份打进启动器 exe（csc /win32icon），一份放进 resources/app 供窗口标题栏/任务栏用。
const iconSrc = path.join(ROOT, 'desktop', 'build', 'icon.ico');
if (!fs.existsSync(iconSrc)) {
  console.error('[build] 缺少图标 ' + iconSrc + '，先跑：node tools/make-icon.mjs 或 python tools/make-icon.py');
  process.exit(1);
}
fs.cpSync(iconSrc, path.join(appDir, 'icon.ico'));

// 本机这套 Electron 运行时一开 Chromium 沙箱就起不来（启动即 0x80000003），
// 带 --no-sandbox 立刻正常。所以随包发一个启动器，快捷方式也走这条；
// 顺带把 DSH 注入的 ELECTRON_RUN_AS_NODE 清掉（有它 exe 会被当成 node 跑）。
// 首选：用系统自带的 csc 编成 exe（自带图标，双击即开，不需要控制台）。
// 兜底：没有 .NET Framework 的机器上仍然可以用 备用启动.cmd。
const cscCandidates = [
  path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
];
const csc = cscCandidates.find((p) => fs.existsSync(p));
const launcherExe = path.join(outDir, '秀米工作台.exe');
if (csc) {
  const csProj = path.join(ROOT, 'tools', 'launcher', 'Launcher.cs');
  const built = spawnSync(
    csc,
    ['/nologo', '/target:winexe', '/platform:anycpu', '/optimize+', '/win32icon:' + iconSrc, '/out:' + launcherExe, '/r:System.Windows.Forms.dll', csProj],
    { encoding: 'utf8' },
  );
  if (built.status !== 0) {
    console.error('[build] 启动器编译失败：\n' + (built.stdout || '') + (built.stderr || ''));
    process.exit(1);
  }
  say('启动器已编译：' + launcherExe + '（' + Math.round(fs.statSync(launcherExe).size / 1024) + ' KB，图标已嵌入）');
} else {
  say('没找到 csc.exe（.NET Framework 4），跳过 exe 启动器，只留 cmd 兜底');
}
const launcherCmd = path.join(outDir, '备用启动.cmd');
fs.writeFileSync(
  launcherCmd,
  [
    '@echo off',
    'rem 秀米工作台 · 兜底启动器（exe 启动器编不出来时用这个；--no-sandbox 是必需参数）',
    'set "ELECTRON_RUN_AS_NODE="',
    'rem 换个工作目录再起：输入法（搜狗）会往 cwd 里丢 debug.log，别让它脏了 dist',
    'cd /d "%TEMP%"',
    'start "" "%~dp0dsh-xiumi.exe" --no-sandbox %*',
    '',
  ].join('\r\n'),
  'utf8',
);

say('壳就位：' + appDir);
say('    shell/  ' + fs.readdirSync(path.join(appDir, 'shell')).join(', '));
say('    host/   ' + fs.readdirSync(path.join(appDir, 'host')).length + ' 个模块');
say('    client/ ' + fs.readdirSync(path.join(appDir, 'client')).join(', '));

// --asar：把 resources/app 打成一个 asar（个别 Electron 构建的 fuse 只认 asar）
if (flag('asar')) {
  const asarFile = path.join(outDir, 'resources', 'app.asar');
  const made = buildAsar(appDir, asarFile);
  fs.rmSync(appDir, { recursive: true, force: true });
  say('已打成 resources/app.asar（' + made.files + ' 个文件，' + Math.round(made.bytes / 1024) + ' KB）');
}

say('双击这个启动：' + (fs.existsSync(launcherExe) ? launcherExe : launcherCmd));
say('（别直接双击 ' + EXE_DST + '：没带 --no-sandbox 会闪退；启动器已经把参数和处理都封好了）');
