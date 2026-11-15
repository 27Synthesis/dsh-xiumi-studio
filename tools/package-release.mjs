#!/usr/bin/env node
/**
 * 打一个"下载就能用"的 Windows 发行包。
 *
 *   node tools/package-release.mjs [--skip-build] [--no-zip]
 *
 * 产物：
 *   release/<name>/                        ← 直接拷给人的目录（= 解压后的样子）
 *   release/<name>.zip                     ← 挂 GitHub Releases 的那个文件
 *   release/SHA256SUMS.txt                 ← certutil -hashfile 对得上
 *
 * 为什么仓库里不放 zip：dist 里有整套 Electron 运行时（200MB+），
 * .gitignore 已排除 desktop/dist 与 release/。发行包每次现场打。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const flag = (n) => process.argv.slice(2).includes('--' + n);

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version || '0.0.0';
const name = 'dsh-xiumi-studio-' + version + '-win-x64';
const dist = path.join(ROOT, 'desktop', 'dist');
const relDir = path.join(ROOT, 'release');
const stage = path.join(relDir, name);
const LAUNCHER = '秀米工作台.exe';

const say = (m) => console.log('[release] ' + m);
function die(m) {
  console.error('[release] ' + m);
  process.exit(1);
}

// 1) 组装 dist（默认重建壳；--skip-build 用现成的）
if (!flag('skip-build')) {
  say('重建 desktop/dist …');
  const r = spawnSync(process.execPath, [path.join(HERE, 'build-desktop.mjs'), '--app-only'], { stdio: 'inherit' });
  if (r.status !== 0) die('build-desktop.mjs 失败');
}

if (!fs.existsSync(path.join(dist, LAUNCHER))) die('缺启动器：' + path.join(dist, LAUNCHER) + '（先跑 node tools/build-desktop.mjs）');
if (!fs.existsSync(path.join(dist, 'dsh-xiumi.exe'))) die('缺 Electron 本体：' + path.join(dist, 'dsh-xiumi.exe'));
if (!fs.existsSync(path.join(dist, 'resources', 'app', 'shell', 'main.js'))) die('dist/resources/app/shell 不完整，重跑 tools/build-desktop.mjs');

// 2) 清旧目录，铺新的一份
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
const SKIP = (p) => /^\.profile/.test(path.basename(p)) || /\.log$/i.test(p) || path.basename(p) === 'debug.log';
let copied = 0;
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from)) {
    const s = path.join(from, entry);
    const d = path.join(to, entry);
    if (SKIP(s)) continue;
    const st = fs.statSync(s);
    if (st.isDirectory()) copyDir(s, d);
    else { fs.copyFileSync(s, d); copied++; }
  }
}
copyDir(dist, stage);
say('运行时与壳：' + copied + ' 个文件');

// 3) 三个给人用的入口：安装 / 卸载 / 说明
//    .cmd 一律 UTF-8 无 BOM + 第二行 chcp 65001，中文才不会变乱码。
const cmdHead = '@echo off\r\nchcp 65001 >nul\r\n';
fs.writeFileSync(
  path.join(stage, '安装.cmd'),
  cmdHead + [
    'rem 在桌面和开始菜单里建「秀米工作台」快捷方式（不需要管理员权限，可重复执行）',
    'setlocal',
    'rem 注意 "%~dp0" 自带尾反斜杠，会把结尾的引号吃掉；补个 "." 让路径合法',
    'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-shortcuts.ps1" -DistDir "%~dp0."',
    'set CODE=%ERRORLEVEL%',
    'echo.',
    'if not "%CODE%"=="0" echo 安装失败，退出码 %CODE%。可以把上面的报错发到项目 issue。',
    'pause',
    'exit /b %CODE%',
    '',
  ].join('\r\n'),
  'utf8',
);
fs.writeFileSync(
  path.join(stage, '卸载.cmd'),
  cmdHead + [
    'rem 只删两个快捷方式；用户数据（%LOCALAPPDATA%\\dsh-xiumi-desktop）保留',
    'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall-shortcuts.ps1"',
    'pause',
    '',
  ].join('\r\n'),
  'utf8',
);
fs.copyFileSync(path.join(HERE, 'install-shortcuts.ps1'), path.join(stage, 'install-shortcuts.ps1'));
fs.copyFileSync(path.join(HERE, 'uninstall-shortcuts.ps1'), path.join(stage, 'uninstall-shortcuts.ps1'));

fs.writeFileSync(
  path.join(stage, '使用说明.txt'),
  [
    '秀米工作台 · 桌面版 ' + version,
    '',
    '一、怎么装',
    '  1) 双击「安装.cmd」→ 桌面和开始菜单里各出现一个「秀米工作台」。',
    '  2) 之后双击桌面图标即可打开；也可以直接双击本目录的「秀米工作台.exe」。',
    '',
    '二、怎么卸',
    '  1) 双击「卸载.cmd」（只删快捷方式，稿子和设置留着）。',
    '  2) 删掉本目录。想连用户数据一起删，见 README 的卸载段。',
    '',
    '三、为什么有这么多文件',
    '  「秀米工作台.exe」是启动器（带图标，自动带 --no-sandbox）；',
    '  「dsh-xiumi.exe」是 Electron 本体，别直接双击，会闪退。',
    '  「备用启动.cmd」是启动器编不出来时的兜底。',
    '',
    '四、数据在哪',
    '  %LOCALAPPDATA%\\dsh-xiumi-desktop\\desktop.log 是启动日志；',
    '  起不来时会弹一个错误窗口，标题栏写着日志路径，照着看。',
    '',
    '五、第一次打开被 SmartScreen 拦',
    '  未签名的 exe 第一次运行会提示，选「更多信息 → 仍要运行」。',
    '',
    '项目主页与问题反馈：见仓库 README。许可：MIT。',
    '',
  ].join('\r\n'),
  'utf8',
);
say('安装/卸载/说明已写入');

// 4) 打包 + 校验和
let zipPath = path.join(relDir, name + '.zip');
if (!flag('no-zip')) {
  fs.rmSync(zipPath, { force: true });
  say('压缩（几百 MB，要一会儿）…');
  const ps = 'Compress-Archive -LiteralPath ' + JSON.stringify(stage).replace(/"/g, "'") +
    ' -DestinationPath ' + JSON.stringify(zipPath).replace(/"/g, "'") + ' -CompressionLevel Optimal -Force';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'inherit' });
  if (r.status !== 0 || !fs.existsSync(zipPath)) die('压缩失败（Compress-Archive 退出码 ' + r.status + '）');
}
const h = crypto.createHash('sha256');
if (fs.existsSync(zipPath)) {
  const fd = fs.openSync(zipPath, 'r');
  const buf = Buffer.allocUnsafe(1 << 20);
  let n;
  while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  fs.closeSync(fd);
  const line = h.digest('hex') + '  ' + name + '.zip\n';
  fs.writeFileSync(path.join(relDir, 'SHA256SUMS.txt'), line, 'utf8');
  const mb = (fs.statSync(zipPath).size / 1048576).toFixed(1);
  say('zip：' + zipPath + '（' + mb + ' MB）');
  say('sha256：' + line.trim());
}
say('目录：' + stage);
