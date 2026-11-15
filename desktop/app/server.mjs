/**
 * 桌面壳的本地 http 服务（纯 node，不依赖 Electron，可以单独 node 起来自测）。
 *
 * 插件自己已经有一整套 /xiumi/api/*（host/routes.mjs），桌面 exe 没有 DSH 宿主，
 * 所以这个服务只做「挂载 + 补壳」：把同一份 createApiHandler 挂在同一个端口上，
 * host/ 与 client/ 只有一份（PLAN-R2 AD-4：桌面只是外壳）。
 *
 * 壳自己补的端点：
 *   GET  /xiumi/api/desktop/info            壳状态：工作目录、端口、Python、版本
 *   POST /xiumi/api/desktop/import-docx     导入 Word（上游只有模型工具，没有 http 路由）
 *   POST /xiumi/api/desktop/workspace       换工作目录
 * 以及 GET / → 302 到 /xiumi/studio?session=desktop。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { locateRoots, loadHost } from './locate.mjs';
import { DESKTOP_SESSION } from './config.mjs';

const MAX_BODY = 32 * 1024 * 1024;

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** 桌面端点也守同源：它们会写盘，不能给随便一个网页留后门。 */
function sameOrigin(req) {
  const host = String((req.headers && req.headers.host) || '');
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return false;
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (origin === 'null') return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function listen(server, port, attempts = 20) {
  return new Promise((resolve, reject) => {
    let tryIndex = 0;
    const attempt = () => {
      const onError = (error) => {
        server.removeListener('listening', onListening);
        if (error && error.code === 'EADDRINUSE' && tryIndex + 1 < attempts) {
          tryIndex++;
          attempt();
          return;
        }
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(port + tryIndex);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port + tryIndex, '127.0.0.1');
    };
    attempt();
  });
}

export async function startServer({ workspace, port = 50577, log = () => {}, version = '', sessionId = DESKTOP_SESSION }) {
  const store = await loadHost('store.mjs');
  const routes = await loadHost('routes.mjs');
  const { root } = locateRoots();

  let cwd = store.canonicalCwd(workspace);
  try {
    fs.mkdirSync(cwd, { recursive: true });
  } catch (error) {
    throw new Error('建不了工作目录 ' + cwd + '：' + ((error && error.message) || error));
  }
  cwd = store.canonicalCwd(cwd);
  store.ensureLayout(cwd);

  const api = routes.createApiHandler({
    // 桌面壳只有一个工作目录：会话 id 只是个占位（client 的 ?session= 仍要求非空）
    resolveCwd: (sid) => (sid ? cwd : null),
    log,
    onRequest: () => {},
  });

  let pythonState = null;

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = url.pathname.replace(/\/+$/, '') || '/';

    // ── 壳自己的端点 ────────────────────────────────────────
    if (route.startsWith('/xiumi/api/desktop/')) {
      if (!sameOrigin(req)) return json(res, 403, { ok: false, error: '跨站请求被拒绝' });
      try {
        if (route === '/xiumi/api/desktop/info' && req.method === 'GET') {
          if (pythonState === null) {
            try {
              const { findPython } = await loadHost('cover.mjs');
              pythonState = await findPython();
            } catch (error) {
              pythonState = { error: (error && error.message) || String(error) };
            }
          }
          const projects = store.listProjects(cwd);
          return json(res, 200, {
            ok: true,
            ...describe(),
            projects: projects.length,
            activeProjectId: store.activeProjectId(cwd, sessionId),
            xiumi: (await loadHost('mcp.mjs')).authorizationStatus(),
          });
        }
        if (route === '/xiumi/api/desktop/import-docx' && req.method === 'POST') {
          const body = await readBody(req);
          const file = String(body.path || body.file || '');
          if (!file) return json(res, 400, { ok: false, error: '需要 path（.docx 文件路径）' });
          const { importDocxFile } = await import('./importer.mjs');
          const out = await importDocxFile({ workspace: cwd, file, sessionId, kicker: String(body.kicker || ''), theme: String(body.theme || ''), log });
          log('[xiumi] 导入 Word：' + out.title + '（' + out.projectId + '）');
          return json(res, 200, { ok: true, ...out });
        }
        if (route === '/xiumi/api/desktop/workspace' && req.method === 'POST') {
          const body = await readBody(req);
          const dir = String(body.path || '');
          if (!dir) return json(res, 400, { ok: false, error: '需要 path（工作目录）' });
          cwd = setWorkspace(dir);
          return json(res, 200, { ok: true, ...describe() });
        }
        return json(res, 404, { ok: false, error: '没有这个桌面端点：' + route });
      } catch (error) {
        log('[xiumi] 桌面端点失败：' + ((error && error.message) || error));
        return json(res, 500, { ok: false, error: (error && error.message) || String(error) });
      }
    }

    // ── 工作台入口 ──────────────────────────────────────────
    if ((req.method === 'GET' || req.method === 'HEAD') && (route === '/' || route === '/studio')) {
      res.writeHead(302, { location: '/xiumi/studio?session=' + encodeURIComponent(sessionId), 'cache-control': 'no-store' });
      res.end();
      return;
    }

    // ── 其余全交给插件自己的处理器 ──────────────────────────
    return api(req, res);
  }

  function describe() {
    return { workspace: cwd, port: server.address() && server.address().port, sessionId, version, pluginRoot: root, python: pythonState };
  }

  function setWorkspace(dir) {
    const abs = path.isAbsolute(dir) ? dir : path.resolve(cwd, dir);
    fs.mkdirSync(abs, { recursive: true });
    cwd = store.canonicalCwd(abs);
    store.ensureLayout(cwd);
    log('[xiumi] 工作目录：' + cwd);
    return cwd;
  }

  const server = http.createServer((req, res) => {
    Promise.resolve(handle(req, res)).catch((error) => {
      try {
        if (!res.headersSent) json(res, 500, { ok: false, error: (error && error.message) || String(error) });
        else res.end();
      } catch {
        /* 连接已经断了 */
      }
      log('[xiumi] 请求失败：' + ((req.method || '') + ' ' + (req.url || '')) + ' → ' + ((error && error.message) || error));
    });
  });

  const actualPort = await listen(server, port);
  if (actualPort !== port) log('[xiumi] 端口 ' + port + ' 被占用，改用 ' + actualPort + '（秀米授权可能要在新端口重新连一次）');

  return {
    server,
    port: actualPort,
    url: 'http://127.0.0.1:' + actualPort,
    sessionId,
    studioUrl: 'http://127.0.0.1:' + actualPort + '/xiumi/studio?session=' + encodeURIComponent(sessionId),
    workspace: cwd,
    info: () => describe(),
    setWorkspace,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// 单独跑（没有 Electron）时：node desktop/app/server.mjs --workspace <dir> --port 50577
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const pick = (name) => {
    const hit = args.find((a) => a === '--' + name || a.startsWith('--' + name + '='));
    if (!hit) return '';
    if (hit.includes('=')) return hit.slice(hit.indexOf('=') + 1);
    return args[args.indexOf(hit) + 1] || '';
  };
  const ws = pick('workspace') || path.join(process.env.USERPROFILE || '.', 'Documents', '秀米工作台');
  const port = Number(pick('port')) || 50577;
  startServer({ workspace: ws, port, version: 'dev', log: (m) => console.log(m) }).then((s) => {
    console.log('[dsh-xiumi] ' + s.studioUrl);
  });
}
