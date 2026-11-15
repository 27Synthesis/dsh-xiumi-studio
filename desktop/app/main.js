/**
 * dsh-xiumi 桌面壳 · Electron 主进程。
 *
 * 这一层只做外壳该做的事（PLAN-R2 AD-4）：
 *   1. 起一个本地 http 服务（server.mjs），把插件自己的 /xiumi/* 挂在回环端口上
 *   2. 开一个窗口指向 /xiumi/studio?session=desktop —— 就是面板里那个完整工作台
 *   3. 补浏览器里没有的东西：菜单、导入 Word 的系统对话框、外部链接交给系统浏览器
 *
 * 没有复制任何业务代码：host/ 与 client/ 就是插件仓库里的那一份。
 */
const { app, BrowserWindow, Menu, dialog, shell, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SHELL_DIR = __dirname;
const APP_TITLE = '秀米工作台';

// 应用图标（tools/make-icon.py 生成，构建时拷到 resources/app/icon.ico）。
// 任务栏与 Alt-Tab 用它；AppUserModelId 让 Windows 把窗口和开始菜单里的快捷方式认成同一个程序，
// 否则任务栏会出现两个互不相干的图标。必须在开窗之前设。
const earlyLogQueue = []; // writeLog 要等 LOG_PATH 定好才能落盘，这之前的日志先排队
function writeLogLater(line) {
  earlyLogQueue.push(line);
}

const ICON_PATH = path.join(SHELL_DIR, '..', 'icon.ico');
const HAS_ICON = fs.existsSync(ICON_PATH);
const APP_USER_MODEL_ID = 'com.xiumi.studio.desktop';
try {
  app.setAppUserModelId(APP_USER_MODEL_ID);
} catch (error) {
  writeLogLater('[dsh-xiumi] 设 AppUserModelId 失败：' + ((error && error.message) || error));
}

// 默认 userData 是从 package.json 的 productName 推出来的（「秀米工作台」→ 中文目录名），
// 这台机器上 Electron 一旦去算这个默认路径就会在 ready 之前直接崩掉（exit 0x80000003 / 0xFFFF8FFD），
// 所以第一件事就是把 userData 固定到纯 ASCII 路径，再去碰任何 getPath。
function pickDataDir() {
  const local = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || process.env.HOME || SHELL_DIR, 'AppData', 'Local');
  const wanted = process.env.XIUMI_DESKTOP_DATA || path.join(local, 'dsh-xiumi-desktop');
  // 只读目录/受限沙箱里建不出来，就退到壳目录下的 .profile，绝不让它退化成中文默认路径
  for (const dir of [wanted, path.join(SHELL_DIR, '.profile')]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch {
      /* 换下一个候选 */
    }
  }
  return path.join(SHELL_DIR, '.profile');
}
const DATA_DIR = pickDataDir();
try {
  app.setPath('userData', DATA_DIR);
  app.setPath('sessionData', DATA_DIR);
} catch (error) {
  writeLogLater('[dsh-xiumi] 设 userData 失败：' + ((error && error.message) || error));
}

// ── 命令行 ────────────────────────────────────────────────
const argv = process.argv.slice(2);
function arg(name) {
  const eq = argv.find((a) => a.startsWith('--' + name + '='));
  if (eq) return eq.slice(eq.indexOf('=') + 1);
  const i = argv.indexOf('--' + name);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return '';
}
const SHOT_PATH = arg('shot');
const DEV = argv.includes('--dev');

let shellState = null; // { server, url, studioUrl, workspace, port }
let win = null;
let homeDir = '';
let cfg = null;
let quitting = false;

async function readConfig(home) {
  const { loadConfig } = await import(pathToFileURL(path.join(SHELL_DIR, 'config.mjs')));
  return loadConfig(home);
}
async function writeConfig(home, next) {
  const { saveConfig } = await import(pathToFileURL(path.join(SHELL_DIR, 'config.mjs')));
  return saveConfig(home, next);
}
function pathToFileURL(p) {
  return require('node:url').pathToFileURL(p).href;
}

// 日志落盘：GUI 进程没有控制台，出问题时得有个地方看
const LOG_PATH =
  process.env.XIUMI_DESKTOP_LOG ||
  path.join(process.env.LOCALAPPDATA || path.dirname(process.execPath), 'dsh-xiumi-desktop', 'desktop.log');

function writeLog(line) {
  while (earlyLogQueue.length) writeLogRaw(earlyLogQueue.shift());
  writeLogRaw(line);
}

function writeLogRaw(line) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, line + '\n');
  } catch {
    /* 日志写不了也不能影响主流程 */
  }
}

function log(msg) {
  const line = '[' + new Date().toISOString() + '] [dsh-xiumi] ' + msg;
  console.log(line);
  writeLog(line);
  if (win && !win.isDestroyed() && DEV) win.webContents.executeJavaScript('console.log(' + JSON.stringify(line) + ')').catch(() => {});
}

process.on('uncaughtException', (error) => {
  log('未捕获异常：' + ((error && error.stack) || error));
  try {
    dialog.showErrorBox('秀米工作台出错了', (error && error.message) || String(error));
  } catch {
    /* 对话框都开不了就只留日志 */
  }
});
process.on('unhandledRejection', (reason) => {
  log('未处理的 Promise 拒绝：' + ((reason && reason.stack) || reason));
});

// ── 起服务 ─────────────────────────────────────────────────
async function boot() {
  homeDir = app.getPath('userData');
  log('boot: 读配置 ' + homeDir);
  cfg = await readConfig(homeDir);
  const workspace = arg('workspace') || cfg.workspace;
  const port = Number(arg('port')) || cfg.port;
  const version = app.getVersion();
  log('boot: 工作目录 ' + workspace + '，端口 ' + port);

  const { startServer } = await import(pathToFileURL(path.join(SHELL_DIR, 'server.mjs')));
  log('boot: server.mjs 已加载，开始监听');
  let started;
  try {
    started = await startServer({ workspace, port, log, version });
  } catch (error) {
    // 工作目录建不出来（只读磁盘、受控文件夹访问、OneDrive 占用、受限沙箱都可能）时
    // 不能停在这一步等人去改权限：退到 userData 里的工作目录，先把界面开出来。
    const fallback = path.join(DATA_DIR, 'workspace');
    log('boot: 工作目录 ' + workspace + ' 不可用（' + ((error && error.message) || error) + '），改用 ' + fallback);
    started = await startServer({ workspace: fallback, port, log, version });
    started.fallbackFrom = workspace;
  }
  log('boot: 服务已起 ' + started.url);
  shellState = started;

  // 第一次跑或工作目录被删过：把实际用的目录写回配置，下次直接命中。
  // 退回的临时目录不写回，免得把用户自己的目录永久顶掉。
  if (!started.fallbackFrom && (cfg.workspace !== started.workspace || cfg.port !== started.port)) {
    await writeConfig(homeDir, { port: started.port, workspace: started.workspace });
  }
  log('工作台 ' + started.studioUrl + '（工作目录 ' + started.workspace + '）');
  return started;
}

// ── 窗口 ───────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 900,
    minHeight: 620,
    show: false,
    backgroundColor: '#F6F2EA',
    title: APP_TITLE,
    icon: HAS_ICON ? ICON_PATH : undefined,
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
    if (DEV) win.webContents.openDevTools({ mode: 'detach' });
  });

  // 站外链接一律交给系统浏览器：秀米登录要用系统浏览器的登录态，页面里的 <a> 也一样
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const base = shellState ? shellState.url : '';
    if (base && url.startsWith(base)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
  });

  win.loadURL(shellState.studioUrl);

  win.webContents.on('did-finish-load', async () => {
    log('页面已加载');
    if (SHOT_PATH) {
      // 截图模式：等页面把 /state 拉回来、画完第一帧，再存图退出
      await new Promise((r) => setTimeout(r, 2200));
      try {
        const image = await win.webContents.capturePage();
        fs.mkdirSync(path.dirname(SHOT_PATH), { recursive: true });
        fs.writeFileSync(SHOT_PATH, image.toPNG());
        console.log('SHOT ' + SHOT_PATH);
      } catch (error) {
        console.error('SHOT FAILED ' + ((error && error.message) || error));
      }
      setTimeout(() => app.exit(0), 300);
    }
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    log('渲染进程没了：' + JSON.stringify(details));
  });

  win.on('closed', () => {
    win = null;
  });
}

// ── 起不来时的那一屏 ───────────────────────────────────────
// 弹窗会在没窗口时挡住整个进程（连日志都看不见），所以启动失败也开一扇窗把原因写清楚，
// 顺便把「换工作目录」留在菜单里，人还能自己救回来。
function createErrorWindow(message) {
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const html = [
    '<!doctype html><meta charset="utf-8"><title>秀米工作台 · 启动失败</title>',
    '<style>',
    'html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;',
    'background:#F6F2EA;color:#2b2b2b;font:15px/1.7 "Microsoft YaHei",system-ui,sans-serif}',
    '.box{max-width:760px;padding:40px 44px;background:#fff;border:1px solid #E3DCCF;border-radius:14px}',
    'h1{margin:0 0 6px;font-size:22px}p{margin:10px 0;color:#5a5347}',
    'code{display:block;margin:16px 0;padding:14px 16px;background:#F7F4EE;border-left:3px solid #8E2B22;',
    'border-radius:6px;font:13px/1.6 Consolas,monospace;white-space:pre-wrap;color:#8E2B22}',
    '.hint{margin-top:18px;padding-top:14px;border-top:1px solid #EFE8DC;color:#6b6355;font-size:13.5px}',
    '</style>',
    '<div class="box"><h1>秀米工作台没能启动</h1>',
    '<p>本地服务或工作目录这一步出错了。原因如下：</p>',
    '<code>' + esc(message) + '</code>',
    '<div class="hint">可以试试：菜单「文件 → 换工作目录…」挑一个能写的目录；或者关掉重开。',
    '<br>日志：' + esc(LOG_PATH) + '</div></div>',
  ].join('');
  const errorWin = new BrowserWindow({
    width: 900,
    height: 620,
    minWidth: 620,
    minHeight: 420,
    backgroundColor: '#F6F2EA',
    title: '秀米工作台 · 启动失败',
    icon: HAS_ICON ? ICON_PATH : undefined,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  errorWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: '文件',
        submenu: [
          { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
        ],
      },
      {
        label: '视图',
        submenu: [
          { role: 'reload', label: '重新载入' },
          { role: 'toggleDevTools', label: '开发者工具' },
        ],
      },
    ]),
  );
  return errorWin;
}

// ── 导入 Word ──────────────────────────────────────────────
async function importWordFlow() {
  if (!win) return;
  const picked = await dialog.showOpenDialog(win, {
    title: '导入 Word 文稿',
    buttonLabel: '导入',
    properties: ['openFile'],
    filters: [{ name: 'Word 文稿', extensions: ['docx'] }],
  });
  if (picked.canceled || !picked.filePaths.length) return;
  const file = picked.filePaths[0];
  try {
    win.setTitle(APP_TITLE + ' · 正在导入…');
    const { importDocxFile } = await import(pathToFileURL(path.join(SHELL_DIR, 'importer.mjs')));
    const out = await importDocxFile({ workspace: shellState.workspace, file, sessionId: shellState.sessionId, log });
    log('导入完成：' + out.title + '（' + out.blocks + ' 块 / ' + out.images + ' 图' + (out.cover ? ' / 有封面' : ' / 无封面') + '）');
    win.setTitle(APP_TITLE);
    win.webContents.reload();
    if (out.coverError) {
      dialog.showMessageBox(win, {
        type: 'warning',
        title: '封面没画出来',
        message: '文稿已经导入，但封面生成失败。',
        detail: out.coverError + '\n\n预览里可以先看正文，封面可以稍后再画。',
      });
    }
  } catch (error) {
    win.setTitle(APP_TITLE);
    dialog.showErrorBox('导入失败', (error && error.message) || String(error));
  }
}

async function changeWorkspaceFlow() {
  if (!win) return;
  const picked = await dialog.showOpenDialog(win, {
    title: '选择工作目录（工程会写在这个目录的 .xiumi/ 里）',
    buttonLabel: '用这个目录',
    defaultPath: shellState.workspace,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (picked.canceled || !picked.filePaths.length) return;
  const dir = picked.filePaths[0];
  shellState.setWorkspace(dir);
  await writeConfig(homeDir, { port: shellState.port, workspace: shellState.workspace });
  win.webContents.reload();
}

// ── 菜单 ───────────────────────────────────────────────────
function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '导入 Word 文稿…', accelerator: 'CmdOrCtrl+O', click: () => importWordFlow() },
        { type: 'separator' },
        { label: '换工作目录…', click: () => changeWorkspaceFlow() },
        { label: '打开工作目录', click: () => shell.openPath(shellState.workspace) },
        { type: 'separator' },
        { label: '在浏览器中打开工作台', click: () => shell.openExternal(shellState.studioUrl) },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        { role: 'toggleDevTools', label: '开发者工具' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于',
          click: async () => {
            const info = shellState.info();
            const python = info.python && info.python.path ? info.python.path : info.python && info.python.error ? '不可用：' + info.python.error : '未检测';
            await dialog.showMessageBox(win, {
              type: 'info',
              title: '关于 ' + APP_TITLE,
              message: APP_TITLE + ' ' + app.getVersion(),
              detail: [
                '工作目录：' + info.workspace,
                '本地端口：' + info.port,
                'Python：' + python,
                '',
                '先连秀米：右上「连接秀米」→ 系统浏览器里登录并同意授权。',
              ].join('\n'),
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── 启动 ───────────────────────────────────────────────────
writeLog(
  '==== ' +
    new Date().toISOString() +
    ' 启动：' +
    process.execPath +
    ' | argv=' +
    JSON.stringify(process.argv.slice(1)) +
    ' | userData=' +
    DATA_DIR +
    ' | log=' +
    LOG_PATH,
);
const gotLock = app.requestSingleInstanceLock();
writeLog('[dsh-xiumi] 单实例锁：' + gotLock);
if (!gotLock) {
  writeLog('[dsh-xiumi] 已有实例在跑，这个进程退出');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.on('ready', () => writeLog('[dsh-xiumi] app ready, version=' + app.getVersion()));
  app.on('will-quit', () => writeLog('[dsh-xiumi] will-quit'));
  app.on('window-all-closed', () => writeLog('[dsh-xiumi] window-all-closed'));

  app.whenReady().then(async () => {
    // 导出 HTML 时让人看见存到哪儿
    session.defaultSession.on('will-download', (_event, item) => {
      item.setSaveDialogOptions({ title: '保存', defaultPath: path.join(shellState.workspace, item.getFilename() || 'xiumi-export.html') });
    });

    try {
      await boot();
    } catch (error) {
      log('启动失败：' + ((error && error.stack) || error));
      const errorWin = createErrorWindow((error && error.message) || String(error));
      if (SHOT_PATH) {
        errorWin.webContents.once('did-finish-load', async () => {
          await new Promise((r) => setTimeout(r, 800));
          try {
            fs.mkdirSync(path.dirname(SHOT_PATH), { recursive: true });
            fs.writeFileSync(SHOT_PATH, (await errorWin.webContents.capturePage()).toPNG());
            console.log('SHOT ' + SHOT_PATH);
          } catch (e) {
            console.error('SHOT FAILED ' + ((e && e.message) || e));
          }
          setTimeout(() => app.exit(1), 200);
        });
      }
      return;
    }
    writeLog('[dsh-xiumi] boot 完成，准备开窗');
    buildMenu();
    createWindow();
    writeLog('[dsh-xiumi] 窗口已创建');
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
  });

  app.on('will-quit', () => {
    if (shellState && shellState.close) {
      try {
        shellState.close();
      } catch {
        /* 进程反正要退了 */
      }
    }
  });
}
