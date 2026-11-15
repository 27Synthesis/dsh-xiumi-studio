#!/usr/bin/env node
/**
 * 桌面壳的冒烟测试（不开 Electron）：起 server.mjs，把面板真正会打的接口走一遍。
 *
 *   node tools/smoke-desktop.mjs [--workspace <dir>] [--port 50599] [--docx <file.docx>]
 *
 * 验的是「最小闭环」：窗口里那个页面能拿到的东西，一样样用 http 要一遍。
 * 给了 --docx 就再验导入 Word（建工程 / 落素材 / 画封面）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SERVER = path.join(ROOT, 'desktop', 'app', 'server.mjs');

function arg(name, fallback) {
  const argv = process.argv.slice(2);
  const eq = argv.find((a) => a.startsWith('--' + name + '='));
  if (eq) return eq.slice(eq.indexOf('=') + 1);
  const i = argv.indexOf('--' + name);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return fallback;
}

const port = Number(arg('port', '50599'));
// 默认落在壳自己的目录里（写作用域内），跑完留着方便看现场
  const workspace = arg('workspace', '') || path.join(ROOT, 'desktop', '.smoke', 'workspace');
const docx = arg('docx', '');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, extra) {
  if (ok) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    failures.push(name + (extra ? '：' + extra : ''));
    console.log('  ✗ ' + name + (extra ? '：' + extra : ''));
  }
}

const child = spawn(process.execPath, [SERVER, '--workspace', workspace, '--port', String(port)], {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let serverLog = '';
child.stdout.on('data', (c) => (serverLog += c.toString()));
child.stderr.on('data', (c) => (serverLog += c.toString()));

const base = 'http://127.0.0.1:' + port;

async function getJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

async function waitReady(timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error('服务进程退出了（code ' + child.exitCode + '）\n' + serverLog);
    try {
      const r = await getJson(base + '/xiumi/api/ping?session=desktop');
      if (r.status === 200 && r.body && r.body.ok) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('服务 20 秒没起来\n' + serverLog);
}

try {
  console.log('[smoke] 工作目录 ' + workspace + '，端口 ' + port);
  await waitReady();
  check('服务起来了，/ping 回 ok', true);

  // 1. 入口：/ 要 302 到工作台（带非空 session——空 session 一切接口都 400）
  {
    const res = await fetch(base + '/', { redirect: 'manual' });
    const loc = res.headers.get('location') || '';
    check('/ 302 到 /xiumi/studio?session=desktop', res.status === 302 && loc.includes('/xiumi/studio?session=desktop'), res.status + ' → ' + loc);
  }

  // 2. 工作台页面与资源
  {
    const page = await fetch(base + '/xiumi/studio?session=desktop');
    const html = await page.text();
    check('工作台 HTML 200 且是 studio 页', page.status === 200 && html.includes('秀米工作台'), 'status ' + page.status);
    const css = await fetch(base + '/xiumi/studio/studio.css');
    check('studio.css 200', css.status === 200 && String(css.headers.get('content-type') || '').includes('css'), 'status ' + css.status);
    const js = await fetch(base + '/xiumi/studio/studio.js');
    check('studio.js 200', js.status === 200, 'status ' + js.status);
  }

  // 3. 面板真正会打的接口
  {
    const ping = await getJson(base + '/xiumi/api/ping?session=desktop');
    check('/api/ping', ping.status === 200 && ping.body.ok === true);
    const themes = await getJson(base + '/xiumi/api/themes?session=desktop');
    check('/api/themes 五套主题', themes.status === 200 && Array.isArray(themes.body.themes) && themes.body.themes.length === 5, JSON.stringify(themes.body).slice(0, 120));
    const state = await getJson(base + '/xiumi/api/state?session=desktop');
    check('/api/state 回 cwd', state.status === 200 && state.body.ok === true && typeof state.body.cwd === 'string', JSON.stringify(state.body).slice(0, 160));
    const noSession = await getJson(base + '/xiumi/api/state');
    check('/api/state 没 session 时 400（和插件一致）', noSession.status === 400, String(noSession.status));
    const info = await getJson(base + '/xiumi/api/desktop/info');
    check('/api/desktop/info', info.status === 200 && info.body.ok === true && info.body.workspace, JSON.stringify(info.body).slice(0, 160));
    check('壳报出了 Python（有值即可，缺了也算环境问题不是壳的错）', 'python' in info.body);
  }

  // 4. 跨站请求要被拦
  {
    const evil = await getJson(base + '/xiumi/api/desktop/info', { headers: { origin: 'https://evil.example', host: '127.0.0.1:' + port } });
    check('桌面端点拒绝跨站 Origin', evil.status === 403, String(evil.status));
  }

  // 5. 导入 Word（可选）
  if (docx) {
    const imported = await getJson(base + '/xiumi/api/desktop/import-docx', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: docx }),
    });
    check('导入 docx 成功', imported.status === 200 && imported.body.ok === true, JSON.stringify(imported.body).slice(0, 200));
    const id = imported.body && imported.body.projectId;
    if (id) {
      const state = await getJson(base + '/xiumi/api/state?session=desktop');
      check('导入后 /api/state 有工程', state.status === 200 && state.body.project && state.body.project.id === id, JSON.stringify(state.body).slice(0, 200));
      check('工程带块与素材', state.body.project.blocks.length > 0, 'blocks=' + state.body.project.blocks.length);
      const cover = await fetch(base + '/xiumi/api/coverimg/' + id + '/cover.png?session=desktop');
      const buf = Buffer.from(await cover.arrayBuffer());
      check('封面图能取到（PNG）', cover.status === 200 && buf.slice(1, 4).toString() === 'PNG', 'status ' + cover.status + ' bytes ' + buf.length);
      const render = await getJson(base + '/xiumi/api/render?projectId=' + id + '&session=desktop');
      check('/api/render 出稿', render.status === 200 && String(JSON.stringify(render.body)).length > 500);
    }
  }

  console.log('');
  console.log('[smoke] ' + pass + ' 通过 / ' + fail + ' 失败');
  if (fail) {
    console.log('[smoke] 失败项：\n  - ' + failures.join('\n  - '));
    if (serverLog.trim()) console.log('[smoke] 服务日志：\n' + serverLog.trim().split('\n').slice(-20).join('\n'));
  }
} catch (error) {
  fail++;
  console.error('[smoke] 崩了：' + ((error && error.message) || error));
  if (serverLog.trim()) console.error('[smoke] 服务日志：\n' + serverLog.trim().split('\n').slice(-20).join('\n'));
} finally {
  child.kill();
  console.log('[smoke] 工作目录留在 ' + workspace);
  process.exit(fail ? 1 : 0);
}
