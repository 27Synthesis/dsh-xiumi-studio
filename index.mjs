/**
 * 秀米图文台 —— 宿主入口。
 *
 * 三件事，都挂在 ctx.effect 上（HMR / 卸载时逐条收回）：
 *   1. 注册模型工具：xiumi_open / xiumi_import_docx / xiumi_make_cover / xiumi_set_theme /
 *      xiumi_set_block / xiumi_preview / xiumi_xiumi_tools / xiumi_publish
 *   2. 注册 /xiumi/* 路由：工作台页面 + 面板读写通道 + 秀米 OAuth 回调
 *   3. 注册 xiumi-studio 技能：把工作流纪律交给模型，插件装好就会用
 *
 * 客户端半边在 client/client.js（右栏面板壳，里面是工作台 iframe）。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerTools } from './host/tools.mjs';
import { createApiHandler, API_PREFIX } from './host/routes.mjs';
import { canonicalCwd, ensureLayout } from './host/store.mjs';
import { authorizationStatus } from './host/mcp.mjs';

export const name = 'dsh-xiumi-studio';

/** 少一个都会被 Cordis 拒绝访问：工具、路由、会话目录、技能。 */
export const inject = ['webServer', 'sessions', 'tools', 'skills'];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const SKILL_DIR = path.join(ROOT, 'skills', 'xiumi-studio');
const SKILL_FILE = path.join(SKILL_DIR, 'SKILL.md');

function makeResolveCwd(ctx) {
  return (sessionId) => {
    try {
      const session = ctx.sessions && ctx.sessions.get ? ctx.sessions.get(sessionId) : null;
      const cwd = session && session.header ? session.header.cwd : null;
      if (cwd) return canonicalCwd(cwd);
    } catch {
      /* 会话已消失就往下走 */
    }
    return null;
  };
}

function readSkillFrontmatter(source) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

function registerSkill(ctx) {
  // 技能文件不在（裁剪过的包）时静默跳过；读得到却注册不上则不吞——模型会以为有纪律却读不到。
  if (!existsSync(SKILL_FILE)) return () => {};
  const source = readFileSync(SKILL_FILE, 'utf8');
  const frontmatter = readSkillFrontmatter(source);
  const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const off = ctx.skills.register({
    name: frontmatter.name || 'xiumi-studio',
    description: frontmatter.description || '秀米图文排版工作流（Word 材料 → 秀米「我的图文」）',
    content: body.trim(),
    // ⚠️ source 必须给：load 时 validateDefinition 要求 source 是字符串
    source: 'bundled',
    resourceBase: { kind: 'directory', path: SKILL_DIR },
  });
  return typeof off === 'function' ? off : () => {};
}

export function apply(ctx) {
  const log = (msg) => {
    try {
      ctx.logger?.info?.(msg);
    } catch {
      /* 没有 logger 不影响功能 */
    }
  };
  const resolveCwd = makeResolveCwd(ctx);

  // 面板/工作台访问时记下真实 origin：模型把地址说给人听时必须是能点开的那个
  let cachedOrigin = null;
  const onRequest = (req) => {
    const host = String((req.headers && req.headers.host) || '');
    if (/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) cachedOrigin = 'http://' + host;
  };
  const origin = () => cachedOrigin || 'http://127.0.0.1:50466';
  const studioUrl = (sessionId) => origin() + '/xiumi/studio' + (sessionId ? '?session=' + encodeURIComponent(sessionId) : '');

  // 工作目录里的 .xiumi 布局在第一次真正用到时创建；这里做一次尽力而为的预处理
  ctx.effect(() => {
    try {
      const sessionList = ctx.sessions && typeof ctx.sessions.list === 'function' ? ctx.sessions.list() : [];
      for (const session of sessionList) {
        const cwd = session && session.header ? session.header.cwd : null;
        if (cwd) ensureLayout(cwd);
      }
    } catch {
      /* 拿不到会话列表就等第一次工具调用时再建 */
    }
    return () => {};
  }, 'xiumi: 初始化 .xiumi 布局');

  // 插件是被热挂载的：任何一半抛错都不该把整个 profile 的加载树带下去。
  // 失败要留痕（log + 面板 404），不要静默，也不要炸宿主。
  const guarded = (label, fn) => {
    try {
      return fn();
    } catch (error) {
      log('[xiumi] ' + label + ' 失败：' + ((error && error.message) || error));
      return () => {};
    }
  };

  // ── 1. 模型工具 ────────────────────────────────────────────
  ctx.effect(
    () =>
      guarded('注册模型工具', () =>
        registerTools(ctx, {
          resolveCwd,
          log,
          studioUrl,
          origin,
          xiumiStatus: () => authorizationStatus(),
        }),
      ),
    'xiumi: 注册模型工具',
  );

  // ── 2. HTTP 路由 ───────────────────────────────────────────
  ctx.effect(() => {
    const webServer = ctx.webServer;
    if (!webServer || typeof webServer.register !== 'function') {
      log('[xiumi] webServer 不可用，工作台与右栏面板将无法打开');
      return () => {};
    }
    return guarded('/xiumi 路由', () => {
      const handler = createApiHandler({ resolveCwd, log, onRequest });
      return webServer.register({ kind: 'prefix', path: API_PREFIX, handler });
    });
  }, 'xiumi: /xiumi 路由');

  // ── 3. 技能 ────────────────────────────────────────────────
  ctx.effect(() => guarded('注册技能', () => registerSkill(ctx)), 'xiumi: 注册技能');
}
