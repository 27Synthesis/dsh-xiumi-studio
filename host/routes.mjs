/**
 * /xiumi/api/* 与 /xiumi/studio 的 HTTP 入口。
 *
 * 边界（与平台口径一致）：
 *   1. 只认本机环路 Host + 同源 Origin（挡 DNS rebinding 与跨站读写）
 *   2. 只按 id 找工程，路径由宿主拼；素材名一律 path.basename
 *   3. 写操作必须 application/json
 */
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as store from './store.mjs';
import * as mcp from './mcp.mjs';
import { renderPage, renderFragment, renderStandalone, countStats } from './render.mjs';
import { getTheme, THEMES } from './themes.mjs';
import { makeCover } from './cover.mjs';
import { describeRemote, publishProject, preflightPublish, uploadProjectAssets } from './xiumi.mjs';
import * as presence from './presence.mjs';
import { collectImages, insertImages, distributeImages, isImageName, bufferFromUpload } from './images.mjs';
import * as templates from './templates.mjs';
import * as templateShows from './template-shows.mjs';
import * as templateFill from './template-fill.mjs';
import { parseSpec } from './template-fill.mjs';

export const API_PREFIX = '/xiumi';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CLIENT_DIR = path.join(ROOT, 'client');
// 图片分开发时前端把原图 base64 传上来：一张手机照片 3–6MB，base64 膨胀 1/3，10 张就要几十 MB。
const MAX_BODY = 64 * 1024 * 1024;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function json(res, code, payload) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}
function fail(res, code, message, extra) {
  json(res, code, { ok: false, error: message, ...(extra || {}) });
}

/** 面板活在 iframe 里，window.open / target=_blank 会被 Electron 或浏览器静默拦掉（用户看到的就是
 *  「点了没反应」）。所以授权页交给宿主用系统默认浏览器打开：这条路完全绕开 iframe 的弹窗策略。
 *  只允许秀米自己的授权地址——这个接口不能变成「让系统随便打开一个 URL」的口子。 */
function isXiumiAuthUrl(target) {
  try {
    const u = new URL(String(target));
    const hostOk = u.hostname === 'xiumi.us' || u.hostname.endsWith('.xiumi.us');
    return u.protocol === 'https:' && hostOk && u.pathname.startsWith('/oauth/');
  } catch (error) {
    return false;
  }
}

function openInSystemBrowser(target) {
  const platform = process.platform;
  if (process.env.DSH_XIUMI_NO_OPEN === '1') return { ok: true, method: 'stub' };
  try {
    const opts = { detached: true, stdio: 'ignore', windowsHide: true };
    if (platform === 'win32') childProcess.spawn('rundll32', ['url.dll,FileProtocolHandler', target], opts).unref();
    else if (platform === 'darwin') childProcess.spawn('open', [target], opts).unref();
    else childProcess.spawn('xdg-open', [target], opts).unref();
    return { ok: true, method: platform };
  } catch (error) {
    return { ok: false, method: platform, error: error.message };
  }
}
/** 面板/工作台要的展示用颜色：字段原样取 host/themes.mjs，不另立色值（PRINCIPLES §1）。
 *  key 就是主题 id，前端按它认主题；paper/wash/ink/sub/line/accent/gold 全给，面板只做浓淡推导。 */
function themeDisplay(t) {
  return {
    key: t.id,
    id: t.id,
    name: t.name,
    tagline: t.tagline,
    desc: t.desc,
    paper: t.paper,
    wash: t.wash,
    ink: t.ink,
    sub: t.sub,
    line: t.line,
    accent: t.accent,
    accentSoft: t.accentSoft,
    gold: t.gold,
    section: t.section,
    radius: t.radius,
    cover: t.cover,
  };
}

/** 事件里记 diff 用：压掉换行，截断到 n 个字符 */
function clip(text, n) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function parseAuthority(authority) {
  try {
    return new URL('http://' + authority);
  } catch {
    return undefined;
  }
}
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const parts = hostname.split('.');
  return parts.length === 4 && parts[0] === '127' && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}
function isLoopbackHost(req) {
  const host = req.headers && req.headers.host;
  if (!host) return false;
  const u = parseAuthority(host);
  return !!u && isLoopbackHostname(u.hostname);
}
export function sameOrigin(req) {
  const host = req.headers && req.headers.host;
  if (!host) return false;
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false;
  const hostUrl = parseAuthority(host);
  if (!hostUrl || !isLoopbackHostname(hostUrl.hostname)) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (origin === 'null') return false;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
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
      } catch (error) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendFile(res, file, cache) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error('not a file');
    res.writeHead(200, { 'content-type': mimeOf(file), 'cache-control': cache || 'no-cache', 'content-length': stat.size });
    fs.createReadStream(file).pipe(res);
    return true;
  } catch {
    return false;
  }
}

function dataUrlFor(cwd, projectId, name) {
  // 读不到就返回空串：让 render 的缺图块显形（P12），而不是抛异常把整个响应打成 500
  try {
    const file = store.assetPath(cwd, projectId, name);
    const buf = fs.readFileSync(file);
    return 'data:' + mimeOf(file) + ';base64,' + buf.toString('base64');
  } catch {
    return '';
  }
}

export function createApiHandler({ resolveCwd, log, onRequest }) {
  function cwdOf(req, url, body) {
    const sessionId =
      (body && body.session) || url.searchParams.get('session') || String(req.headers['x-dsh-session'] || '');
    const cwd = sessionId ? resolveCwd(sessionId) : null;
    return { sessionId, cwd };
  }

  function loadProject(cwd, url, body, wanted) {
    const id = wanted || (body && body.projectId) || url.searchParams.get('projectId') || store.activeProjectId(cwd, (body && body.session) || url.searchParams.get('session'));
    if (!id) throw new Error('还没有任何图文工程，请先让我用 Word 素材建一篇');
    const project = store.readProject(cwd, id);
    if (!project) throw new Error('找不到工程：' + id);
    return project;
  }

  function originOf(req) {
    return 'http://' + String(req.headers.host || '127.0.0.1:0');
  }

  return async function handler(req, res) {
    try {
      if (typeof onRequest === 'function') onRequest(req);
    } catch {
      /* 记录访问来源失败不影响请求本身 */
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = url.pathname.replace(/\/+$/, '') || '/';

    // ── 静态页面与资源 ───────────────────────────────────────
    if (route === '/xiumi/studio' || route === '/xiumi/studio/') {
      const file = path.join(CLIENT_DIR, 'studio.html');
      if (!sendFile(res, file)) res.writeHead(404).end('studio.html missing');
      return;
    }
    if (route.startsWith('/xiumi/studio/')) {
      const name = path.basename(route.slice('/xiumi/studio/'.length));
      const file = path.join(CLIENT_DIR, name);
      if (!sendFile(res, file)) res.writeHead(404).end('not found');
      return;
    }

    if (!route.startsWith('/xiumi/api')) {
      res.writeHead(404).end('not found');
      return;
    }

    // OAuth 回调必须是例外：它是从 xiumi.us 跳回来的顶层导航，浏览器一定标成 cross-site，
    // 用同源规则挡它等于把授权码直接扔掉（真实事故：码拿回来 403，换 token 前就死了）。
    // 回调的防线是 state（startAuthorization 生成、finishAuthorization 校验），不是同源；
    // 但仍要求 Host 是本机环路，避免被 DNS rebinding 指到别处。
    const oauthCallback = req.method === 'GET' && route === '/xiumi/api/oauth/callback' && isLoopbackHost(req);
    if (!oauthCallback && !sameOrigin(req)) {
      json(res, 403, { ok: false, error: '跨站请求被拒绝' });
      return;
    }

    try {
      // 素材与封面是 GET，允许不带 Origin 的 img 请求
      const assetMatch = /^\/xiumi\/api\/asset\/([^/]+)\/(.+)$/.exec(route);
      if (assetMatch && (req.method === 'GET' || req.method === 'HEAD')) {
        const { sessionId, cwd } = cwdOf(req, url, null);
        if (!cwd) return fail(res, 400, '缺少 session');
        const pid = decodeURIComponent(assetMatch[1]);
        const name = decodeURIComponent(assetMatch[2]);
        const file = store.assetPath(cwd, pid, name);
        if (!sendFile(res, file, 'public, max-age=300')) return fail(res, 404, '素材不存在');
        return;
      }
      const coverMatch = /^\/xiumi\/api\/coverimg\/([^/]+)\/(cover|square)\.png$/.exec(route);
      if (coverMatch && (req.method === 'GET' || req.method === 'HEAD')) {
        const { cwd } = cwdOf(req, url, null);
        if (!cwd) return fail(res, 400, '缺少 session');
        const file = store.coverPath(cwd, decodeURIComponent(coverMatch[1]), coverMatch[2]);
        if (!sendFile(res, file, 'no-cache')) return fail(res, 404, '封面还没生成');
        return;
      }

      if (req.method === 'GET' && route === '/xiumi/api/ping') {
        return json(res, 200, { ok: true, pong: Date.now() });
      }

      // 面板配色：五套主题的展示用颜色，单一来源是 themes.mjs（工作台加载后据此写 --paper/--ink/--accent…）
      if (req.method === 'GET' && route === '/xiumi/api/themes') {
        return json(res, 200, { ok: true, themes: THEMES.map(themeDisplay) });
      }

      if (req.method === 'GET' && route === '/xiumi/api/state') {
        const { sessionId, cwd } = cwdOf(req, url, null);
        if (!cwd) return fail(res, 400, '缺少 session（面板需要在一个会话里打开）');
        const activeId = url.searchParams.get('projectId') || store.activeProjectId(cwd, sessionId);
        const project = activeId ? store.readProject(cwd, activeId) : null;
        return json(res, 200, {
          ok: true,
          sessionId,
          cwd,
          project,
          projects: store.listProjects(cwd),
          themes: THEMES.map(themeDisplay),
          stats: project ? countStats(project) : null,
          xiumi: mcp.authorizationStatus(),
          // 前端看到这条就把右侧栏切到工作台；切完 POST /xiumi/api/open-ack 把它清掉。
          openRequest: presence.readOpen(cwd),
        });
      }

      if (req.method === 'GET' && route === '/xiumi/api/templates') {
        const q = url.searchParams.get('q') || '';
        const limit = Math.min(20, Math.max(1, Math.floor(Number(url.searchParams.get('limit')) || 8)));
        let catalog = templates.readCatalog();
        let cached = true;
        if (!catalog) {
          cached = false;
          try {
            catalog = await templates.refreshCatalog();
          } catch (error) {
            return json(res, 200, { ok: false, error: '模板目录没拉到：' + ((error && error.message) || String(error)), items: [] });
          }
        }
        const items = templates.searchCatalog(catalog.items, { q, limit });
        return json(res, 200, { ok: true, q, cached, total: (catalog.items || []).length, fetchedAt: catalog.fetchedAt || null, items });
      }

      if (req.method === 'POST' && route === '/xiumi/api/templates/refresh') {
        try {
          const catalog = await templates.refreshCatalog();
          return json(res, 200, { ok: true, total: (catalog.items || []).length, fetchedAt: catalog.fetchedAt || null, stoppedReason: catalog.stoppedReason || null });
        } catch (error) {
          return json(res, 200, { ok: false, error: '模板目录没拉到：' + ((error && error.message) || String(error)) });
        }
      }

      if (req.method === 'GET' && route === '/xiumi/api/xiumi/status') {
        return json(res, 200, { ok: true, ...mcp.authorizationStatus() });
      }

      if (req.method === 'GET' && route === '/xiumi/api/xiumi/tools') {
        try {
          const tools = await describeRemote();
          return json(res, 200, { ok: true, tools });
        } catch (error) {
          return json(res, 200, { ok: false, error: error.message, code: error.code || null });
        }
      }

      if (req.method === 'GET' && route === '/xiumi/api/oauth/start') {
        const redirectUri = originOf(req) + '/xiumi/api/oauth/callback';
        const started = await mcp.startAuthorization(redirectUri);
        return json(res, 200, { ok: true, url: started.url, redirectUri });
      }

      if (req.method === 'GET' && route === '/xiumi/api/oauth/open') {
        const target = url.searchParams.get('url') || '';
        if (!isXiumiAuthUrl(target)) return fail(res, 400, '只打开秀米授权地址');
        const opened = openInSystemBrowser(target);
        if (!opened.ok) return fail(res, 500, '系统浏览器没打开：' + opened.error, { url: target });
        return json(res, 200, { ok: true, method: opened.method });
      }

      if (req.method === 'GET' && route === '/xiumi/api/oauth/callback') {
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const err = url.searchParams.get('error');
        if (err) {
          res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
          res.end('<meta charset="utf-8"><body style="font:16px/1.8 system-ui;padding:40px;">授权被拒绝或失败：' + String(err).replace(/[<>]/g, '') +
            '<script>try{if(window.opener&&!window.opener.closed){window.opener.postMessage({type:"xiumi:oauth",ok:false},window.location.origin)}}catch(e){}</script></body>');
          return;
        }
        try {
          await mcp.finishAuthorization({ code, state });
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          // 这张确认页也别自己定色：纸色/墨色取主题表（PRINCIPLES §1 没有例外）
          const paperTheme = getTheme('zhusha') || THEMES[0] || {};
          res.end(
            '<meta charset="utf-8"><body style="font:16px/1.8 -apple-system,system-ui;padding:48px;background:' +
              (paperTheme.paper || 'transparent') + ';color:' + (paperTheme.ink || 'inherit') + ';">' +
              '<h2 style="margin:0 0 12px;font-size:20px;">秀米已连接</h2>' +
              '<p>可以关掉这个窗口，回到 DSH 右侧栏继续。接下来我可以直接把图文发布进你的「我的图文」。</p>' +
              '<script>' +
              'try{if(window.opener&&!window.opener.closed){window.opener.postMessage({type:"xiumi:oauth",ok:true},window.location.origin)}}catch(e){}' +
              'setTimeout(function(){try{window.close()}catch(e){}},1200)' +
              '</script></body>'
          );
        } catch (error) {
          res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
          res.end('<meta charset="utf-8"><body style="font:16px/1.8 system-ui;padding:40px;">换 token 失败：' + String(error.message).replace(/[<>&]/g, '') + '</body>');
        }
        return;
      }

      if (req.method === 'GET' && route === '/xiumi/api/render') {
        const { sessionId, cwd } = cwdOf(req, url, null);
        if (!cwd) return fail(res, 400, '缺少 session');
        const project = loadProject(cwd, url, null);
        const mode = url.searchParams.get('mode') || 'page';
        const origin = originOf(req);
        // 文件不在盘上就返回空串：渲染成缺图框（比给一个 404 地址、浏览器里只显示裂图更清楚）
        const assetUrl = (name) => {
          if (!fs.existsSync(store.assetPath(cwd, project.id, name))) return '';
          return origin + '/xiumi/api/asset/' + project.id + '/' + encodeURIComponent(name) + '?session=' + encodeURIComponent(sessionId || '');
        };
        // 内联图片：mode=embed / mode=export 本身就是「要能把图带走的版本」，不再要求另外传 embed=1
        const embed = url.searchParams.get('embed') === '1' || mode === 'embed' || mode === 'export';
        // remote=1：图用秀米图床地址（粘进秀米编辑器用这一版；本机地址秀米服务器取不到）
        const preferRemote = url.searchParams.get('remote') === '1';
        const opts = {
          assetUrl: embed ? (name) => dataUrlFor(cwd, project.id, name) : assetUrl,
          heroAsset: (project.blocks.find((b) => b.type === 'image') || {}).asset,
          preferRemote,
        };
        if (mode === 'fragment' || mode === 'embed' || mode === 'export') {
          // 预览外壳（iframe 的 margin / 滚动条）由前端负责，宿主只产出同一份片段：
          // 预览、复制到秀米、导出 HTML 走的必须是同一个 renderFragment。
          // 先渲染完再写头：渲染抛异常时才能干净地回 500，而不是「头已发出去」二次 writeHead。
          const html = mode === 'export' ? renderStandalone(project, opts) : renderFragment(project, opts);
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(html);
          return;
        }
        const out = renderPage(project, opts);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(out.page);
        return;
      }

      // ── 模板：账号里哪些作品能当成模板来套（GET，必须放在写方法守卫之前）──
      if (req.method === 'GET' && route === '/xiumi/api/template/shows') {
        const { cwd } = cwdOf(req, url, null);
        if (!cwd) return fail(res, 400, '缺少 session');
        try {
          const refresh = url.searchParams.get('refresh') === '1';
          const items = await templateShows.inspectAccountShows(cwd, { refresh });
          return json(res, 200, {
            ok: true,
            total: items.length,
            templates: items.filter((i) => i.isTemplate),
            others: items.filter((i) => !i.isTemplate),
          });
        } catch (error) {
          return json(res, 200, { ok: false, error: '读账号作品失败：' + ((error && error.message) || String(error)) });
        }
      }

      // health 也是 GET：它原来放在写方法守卫后面，GET 永远 405（真机实测踩到）
      if (req.method === 'GET' && route === '/xiumi/api/health') {
        const { cwd } = cwdOf(req, url, null);
        if (!cwd) return fail(res, 400, '缺少 session');
        return json(res, 200, { ok: true, dirs: { root: store.rootOf(cwd) } });
      }

      // ── 写方法 ──────────────────────────────────────────────
      if (req.method !== 'POST') return fail(res, 405, '方法不支持');
      const type = String(req.headers['content-type'] || '');
      if (!type.includes('application/json')) return fail(res, 415, '写操作必须 application/json');
      const body = await readBody(req);
      const { sessionId, cwd } = cwdOf(req, url, body);
      if (!cwd) return fail(res, 400, '缺少 session（面板需要在一个会话里打开）');

      if (route === '/xiumi/api/open-ack') {
        // body 在上面已经读过一次；这里再读一次会让请求永远等不到 end。
        const cleared = presence.clearOpen(cwd, body.at);
        return json(res, 200, { ok: true, cleared });
      }

      if (route === '/xiumi/api/active') {
        const id = String(body.projectId || '');
        const project = store.readProject(cwd, id);
        if (!project) return fail(res, 404, '找不到工程');
        store.setActive(cwd, sessionId, id);
        return json(res, 200, { ok: true, project });
      }

      if (route === '/xiumi/api/layout-images') {
        const project = loadProject(cwd, url, body);
        const out = distributeImages(cwd, project.id);
        store.addEvent(cwd, project.id, 'images', '把 ' + out.moved + ' 张图按小节重新分');
        return json(res, 200, { ok: true, moved: out.moved, project: out.project });
      }

      if (route === '/xiumi/api/duplicate') {
        const project = loadProject(cwd, url, body);
        const copy = store.duplicateProject(cwd, project.id, { title: typeof body.title === 'string' && body.title ? body.title : '' });
        if (sessionId) store.setActive(cwd, sessionId, copy.id);
        return json(res, 200, { ok: true, project: copy });
      }

      if (route === '/xiumi/api/assets/remove') {
        const project = loadProject(cwd, url, body);
        const name = String(body.name || '');
        const out = store.removeAsset(cwd, project.id, name);
        return json(res, 200, { ok: true, removed: name, removedBlocks: out.removedBlocks, project: out.project });
      }

      if (route === '/xiumi/api/theme') {
        const project = loadProject(cwd, url, body);
        const theme = String(body.theme || '');
        if (!THEMES.some((t) => t.id === theme)) return fail(res, 400, '没有这个主题：' + theme);
        const updated = store.updateProject(cwd, project.id, (p) => {
          p.theme = theme;
          return p;
        });
        store.addEvent(cwd, project.id, 'theme', '换成「' + getTheme(theme).name + '」主题');
        return json(res, 200, { ok: true, project: store.readProject(cwd, project.id) });
      }

      if (route === '/xiumi/api/assets/to-xiumi') {
        const project = loadProject(cwd, url, body);
        const readAsset = (name) => {
          const file = store.assetPath(cwd, project.id, name);
          return fs.existsSync(file) ? fs.readFileSync(file) : null;
        };
        const out = await uploadProjectAssets(project, { readAsset });
        store.updateProject(cwd, project.id, (p) => {
          p.blocks = project.blocks;
          return p;
        });
        if (out.uploaded.length) store.addEvent(cwd, project.id, 'publish', '传了 ' + out.uploaded.length + ' 张图进秀米图库');
        return json(res, 200, { ok: out.failed.length === 0, uploaded: out.uploaded, skipped: out.skipped, failed: out.failed, project: store.readProject(cwd, project.id) });
      }

      if (route === '/xiumi/api/assets') {
        const project = loadProject(cwd, url, body);
        const notes = [];
        const items = [];
        const uploads = Array.isArray(body.files) ? body.files : [];
        for (const f of uploads) {
          const name = String((f && f.name) || 'image.png');
          if (!isImageName(name)) {
            notes.push(name + '：不是支持的格式（png / jpg / gif / webp）');
            continue;
          }
          let buf = null;
          try {
            buf = bufferFromUpload(f.data, name);
          } catch (error) {
            notes.push(name + '：' + error.message);
            continue;
          }
          if (buf.length > MAX_IMAGE_BYTES) {
            notes.push(name + '：超过 12MB，先在本地压一下');
            continue;
          }
          items.push({ name, buffer: buf, source: 'upload' });
        }

        // 也能直接给路径：Word 已经导入、图片在另一个文件夹时，人只要报个路径。
        const paths = Array.isArray(body.paths) ? body.paths : body.path ? [body.path] : [];
        if (paths.length) {
          const collected = collectImages(paths, cwd);
          for (const s of collected.skipped) notes.push(s.path + '：' + s.reason);
          for (const abs of collected.files) {
            try {
              const stat = fs.statSync(abs);
              if (stat.size > MAX_IMAGE_BYTES) {
                notes.push(path.basename(abs) + '：超过 12MB');
                continue;
              }
              items.push({ name: path.basename(abs), buffer: fs.readFileSync(abs), source: abs });
            } catch (error) {
              notes.push(path.basename(abs) + '：读不出来（' + error.message + '）');
            }
          }
        }

        if (!items.length) {
          return fail(res, 400, '没有可用的图片' + (notes.length ? '：' + notes.join('；') : ''));
        }
        const placement = body.placement === 'end' ? 'end' : 'section';
        const result = insertImages(cwd, project.id, items, { after: body.after, captions: body.captions, placement });
        store.addEvent(cwd, project.id, 'images', '补进 ' + result.added.length + ' 张图（' + result.added.map((a) => a.name).join(', ') + '）');
        return json(res, 200, { ok: true, added: result.added, skipped: notes, project: store.readProject(cwd, project.id) });
      }

      if (route === '/xiumi/api/block') {
        const project = loadProject(cwd, url, body);
        const blockId = String(body.blockId || '');
        const action = String(body.action || '');
        let note = '';
        const updated = store.updateProject(cwd, project.id, (p) => {
          const i = p.blocks.findIndex((b) => b.id === blockId);
          if (i < 0) throw new Error('没有这个块：' + blockId);
          const cur = p.blocks[i];
          const before = String(cur.text || '');
          if (action === 'remove') {
            p.blocks.splice(i, 1);
            note = '删掉块 ' + blockId + '（' + cur.type + '：' + clip(before || cur.caption || cur.asset, 20) + '）';
          } else if (action === 'up' && i > 0) {
            const [b] = p.blocks.splice(i, 1);
            p.blocks.splice(i - 1, 0, b);
            note = '上移块 ' + blockId + '（' + clip(before || b.caption || b.asset, 16) + '）';
          } else if (action === 'down' && i < p.blocks.length - 1) {
            const [b] = p.blocks.splice(i, 1);
            p.blocks.splice(i + 1, 0, b);
            note = '下移块 ' + blockId + '（' + clip(before || b.caption || b.asset, 16) + '）';
          } else if (action === 'caption') {
            const value = String(body.value == null ? '' : body.value);
            p.blocks[i].caption = value;
            note = '改图注 ' + blockId + '：「' + clip(cur.caption, 20) + '」→「' + clip(value, 20) + '」';
          } else if (action === 'text') {
            const value = String(body.value == null ? '' : body.value);
            // 硬约束：文稿不删改。清空正文必须显式带 allowEmpty，免得一条手滑的请求把整段抹掉。
            if (!value.trim() && before.trim() && body.allowEmpty !== true) {
              throw new Error('不能把正文清空（文稿不允许删改）：确实要清空请带 allowEmpty: true，并先把原文抄一份');
            }
            p.blocks[i].text = value;
            note = '改正文 ' + blockId + '：「' + clip(before, 24) + '」→「' + clip(value, 24) + '」';
          } else {
            throw new Error('未知操作：' + action);
          }
          return p;
        });
        store.addEvent(cwd, project.id, 'edit', note || ('调整块：' + action + ' ' + blockId));
        return json(res, 200, { ok: true, project: store.readProject(cwd, project.id) });
      }

      if (route === '/xiumi/api/meta') {
        const project = loadProject(cwd, url, body);
        store.updateProject(cwd, project.id, (p) => {
          for (const key of ['title', 'subtitle', 'kicker', 'date']) {
            if (typeof body[key] === 'string') p[key] = body[key];
          }
          return p;
        });
        return json(res, 200, { ok: true, project: store.readProject(cwd, project.id) });
      }

      if (route === '/xiumi/api/cover') {
        const project = loadProject(cwd, url, body);
        const dir = store.projectDir(cwd, project.id);
        const made = await makeCover({ project, dir, log });
        store.updateProject(cwd, project.id, (p) => {
          p.cover = { cover: 'cover.png', square: 'square.png', at: new Date().toISOString() };
          return p;
        });
        store.addEvent(cwd, project.id, 'cover', '封面已重绘（「' + getTheme(project.theme).name + '」配色）');
        return json(res, 200, { ok: true, cover: made });
      }

      if (route === '/xiumi/api/publish') {
        const project = loadProject(cwd, url, body);
        const origin = originOf(req);
        // ① 先换图床地址（本机地址秀米取不到），② 再体检，③ 才谈投递。
        const readAsset = (name) => {
          const file = store.assetPath(cwd, project.id, name);
          return fs.existsSync(file) ? fs.readFileSync(file) : null;
        };
        const up = await uploadProjectAssets(project, { readAsset });
        if (up.uploaded.length) {
          store.updateProject(cwd, project.id, (p) => {
            p.blocks = project.blocks;
            return p;
          });
        }
        const pre = preflightPublish(project, { origin, allowLocalImages: true });
        if (!pre.ok) {
          const blocked = pre.issues.filter((i) => i.level === 'block');
          return json(res, 409, {
            ok: false,
            error: '先别发：' + blocked.map((i) => i.msg).join(' '),
            blocked,
            warnings: pre.issues.filter((i) => i.level === 'warn'),
            upload: up,
          });
        }
        const html = renderFragment(project, {
          preferRemote: true,
          assetUrl: (name) => origin + '/xiumi/api/asset/' + project.id + '/' + encodeURIComponent(name) + '?session=' + encodeURIComponent(sessionId || ''),
        });
        try {
          const result = await publishProject(project, { html });
          store.updateProject(cwd, project.id, (p) => {
            p.xiumi = { tool: result.tool, text: result.text, at: new Date().toISOString(), structured: result.structured || null };
            p.status = 'published';
            return p;
          });
          store.addEvent(cwd, project.id, 'publish', '已通过秀米 MCP（' + result.tool + '）投递');
          return json(res, 200, { ok: true, result, upload: up });
        } catch (error) {
          // 秀米 MCP 没有「新建图文」的接口：这不是失败，是要走粘贴这条路（实测能真进「我的图文」）。
          if (/没有创建图文|没有.*创建图文的工具/.test(String(error.message || ''))) {
            store.updateProject(cwd, project.id, (p) => {
              p.status = 'ready';
              return p;
            });
            store.addEvent(cwd, project.id, 'publish', '已备好粘贴版（秀米 MCP 没有新建图文接口）');
            return json(res, 200, {
              ok: true,
              ready: true,
              upload: up,
              hint: '秀米接口不能新建图文。已把图传进图床：点「复制到秀米」→ 在「我的图文」新建空白图文 → 正文区 Ctrl+V → 右上「保存」（或 Ctrl+S）→ 填标题。',
            });
          }
          throw error;
        }
      }

      // ── 模板：复制一份再把这篇的文字图片灌进去（dryRun 只预检）────────
      if (req.method === 'POST' && route === '/xiumi/api/template/apply') {
        const project = loadProject(cwd, url, body);
        let showId = Number(body && body.showId);
        const dryRun = body.dryRun !== false;
        try {
          let picked = null;
          if (!showId) {
            // 没指定就自己挑：按题材命中 + 槽位够用算分，并把理由带回去
            const items = await templateShows.inspectAccountShows(cwd, {});
            const rank = templateShows.rankTemplates({ project, items });
            if (!rank.picked) return json(res, 200, { ok: false, error: '账号里没有可套的模板：先在秀米模板库点「使用模板」存一篇，再刷新' });
            picked = rank.picked;
            showId = picked.showId;
          }
          const out = await templateShows.fillTemplate({
            project,
            cwd,
            templateShowId: showId,
            dryRun,
            titlePostfix: (body && body.titlePostfix) || '·' + new Date().toISOString().slice(11, 16).replace(':', ''),
            blankUnused: body.blankUnused !== false,
            // 真跑前把本地图传进秀米图床（干跑不传：干跑必须零副作用）
            readAsset: dryRun
              ? null
              : (name) => {
                  const file = store.assetPath(cwd, project.id, name);
                  return fs.existsSync(file) ? fs.readFileSync(file) : null;
                },
          });
          if (!dryRun) {
            // 上传换回的 remoteUrl 写回工程，下次就不用再传
            store.updateProject(cwd, project.id, (p) => {
              p.blocks = project.blocks;
              return p;
            });
          }
          if (!dryRun && out.ok) {
            store.addEvent(cwd, project.id, 'template', '已套用模板（秀米作品 ' + out.showId + '）');
          }
          return json(res, 200, { ok: Boolean(out.ok), ...out, picked: picked ? { showId: picked.showId, title: picked.title, score: picked.score, reasons: picked.reasons } : null });
        } catch (error) {
          return json(res, 200, { ok: false, error: '套模板失败：' + ((error && error.message) || String(error)) });
        }
      }

      // ── 模板：把内容灌进「已经复制好的那一篇」，不再复制 ───────────────
      if (req.method === 'POST' && route === '/xiumi/api/template/fill') {
        const project = loadProject(cwd, url, body);
        const showId = Number(body && body.showId);
        if (!showId) return fail(res, 400, '缺少 showId（要填哪一篇）');
        const dryRun = body.dryRun !== false;
        try {
          // 归属校验：只改本插件复制出来的、未发布的副本（审查 C5）
          await templateShows.assertFillTarget(cwd, showId, project);
          let upload = null;
          if (!dryRun) {
            upload = await uploadProjectAssets(project, {
              readAsset: (name) => {
                const file = store.assetPath(cwd, project.id, name);
                return fs.existsSync(file) ? fs.readFileSync(file) : null;
              },
            });
            store.updateProject(cwd, project.id, (p) => {
              p.blocks = project.blocks;
              return p;
            });
          }
          const spec = parseSpec(await templateFill.fetchSpec(showId));
          // 干跑不新建透明图，只用进程内已缓存的（零副作用）
          const blank = body.blankUnused === false ? '' : dryRun ? templateFill.cachedBlankImageUrl() : await templateFill.blankImageUrl();
          const plan = templateFill.planFill({ spec, project, blankImageUrl: blank });
          if (upload && upload.failed.length) {
            plan.warnings.unshift('有 ' + upload.failed.length + ' 张图没传进秀米图床（' + upload.failed.map((f) => f.name + '：' + f.error).join('；') + '）');
          }
          const out = await templateFill.applyFill(showId, plan, { dryRun });
          return json(res, 200, {
            ok: Boolean(out.ok),
            text: out.text,
            warnings: plan.warnings,
            bindings: plan.bindings.length,
            updatedSlots: out.updatedSlots,
            expected: out.expected,
            errors: out.errors,
            notes: out.notes,
            uploaded: upload ? upload.uploaded.length : 0,
            failedUploads: upload ? upload.failed : [],
          });
        } catch (error) {
          return json(res, 200, { ok: false, error: '填槽失败：' + ((error && error.message) || String(error)) });
        }
      }

      return fail(res, 404, '未知接口：' + route);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      log('[xiumi] ' + req.method + ' ' + route + ' 失败：' + message);
      return fail(res, 400, message, error && error.schema ? { schema: error.schema } : error && error.tools ? { tools: error.tools } : undefined);
    }
  };
}
