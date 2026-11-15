/**
 * 秀米 MCP 客户端（https://xiumi.us/mcp）。
 *
 * 授权链（2026-11 实测）：
 *   1. 动态注册：POST /oauth/register（公开客户端，token_endpoint_auth_method: none）
 *   2. PKCE：GET /oauth/authorize?...&code_challenge=S256 → 302 到登录页，
 *      **必须由人在浏览器里登录并同意**，这一步无法自动化
 *   3. 回调带上 code，POST /oauth/token 换 access_token / refresh_token
 *   4. 之后 POST /mcp（JSON-RPC 2.0）即可 tools/list、tools/call
 *
 * 凭证存在用户级 ~/.dsh/xiumi/oauth.json：同一台机器上用一次授权，所有工作目录共用。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// 仅本模块使用：外面没有第二个调用点，不 export（PRINCIPLES §4）。
const MCP_URL = 'https://xiumi.us/mcp';
const REGISTER_URL = 'https://xiumi.us/oauth/register';
const AUTHORIZE_URL = 'https://xiumi.us/oauth/authorize';
const TOKEN_URL = 'https://xiumi.us/oauth/token';
const RESOURCE = 'https://xiumi.us/mcp';
const SCOPE = 'default';
const CLIENT_NAME = 'DSH Xiumi Studio';

/**
 * 所有请求的默认超时（毫秒）。
 * 秀米侧挂住时，工具调用不能无限等；调用方可传 { timeoutMs } 覆盖。
 */
export const DEFAULT_TIMEOUT_MS = 15000;

// XIUMI_HOME 只给自测用：把凭证写到临时目录，别碰用户真账号。
// 用函数而不是常量取路径，自测里换目录时才真的换得动。
function homeDir() {
  return process.env.XIUMI_HOME || path.join(os.homedir(), '.dsh', 'xiumi');
}
function credFile() {
  return path.join(homeDir(), 'oauth.json');
}
function pendingFile() {
  return path.join(homeDir(), 'pending.json');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * 凭证目录与文件的权限：目录 0o700，文件 0o600。
 * 目录可能已被别的代码（或旧版本）建成 0755，所以 mkdir 之后统一 chmod 一次；
 * 文件同理——旧版本写出来的 oauth.json 是 0644，这里顺手收回来。
 * Windows 没有 POSIX 权限位，chmod 基本是空操作，包在 try 里：收不拢不能影响写凭证。
 */
function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* Windows / 只读介质：权限位收不拢就算了，别因此写不进去 */
  }
}
function writeJson(file, value) {
  ensurePrivateDir(path.dirname(file));
  const tmp = file + '.tmp';
  // tmp 先按 0o600 建，rename 之后不会有一瞬间是 0644
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600); // umask 或旧文件留下的宽权限，都在这儿收回来
  } catch {
    /* 同上 */
  }
}

/**
 * 凭证文件有两层，别再把它们摊平了：
 *   clients[redirectUri] = { clientId, createdAt }   ← 端口一变就得重新注册一个客户端
 *   token = { clientId, accessToken, ... }           ← token 记住签发它的 client，注册新客户端不影响它
 * 这样宿主重启换了端口（50466 → 63299）也只需要重新注册，不用让人再登一次秀米。
 */
function emptyCreds() {
  return { version: 2, clients: {}, token: null };
}

function normalizeCreds(raw) {
  if (!raw || typeof raw !== 'object') return emptyCreds();
  const clients = raw.clients && typeof raw.clients === 'object' ? { ...raw.clients } : {};
  // 旧格式：{ clientId, redirectUri, accessToken, ... } 全都摊在一层
  if (raw.clientId && raw.redirectUri && !clients[raw.redirectUri]) {
    clients[raw.redirectUri] = { clientId: raw.clientId, createdAt: raw.createdAt || null };
  }
  let token = raw.token && typeof raw.token === 'object' ? raw.token : null;
  if (!token && raw.accessToken) {
    token = {
      clientId: raw.clientId || null,
      accessToken: raw.accessToken,
      refreshToken: raw.refreshToken || null,
      expiresAt: raw.expiresAt || null,
      scope: raw.scope || null,
      authorizedAt: raw.authorizedAt || null,
    };
  }
  return { version: 2, clients, token };
}

function storedCreds() {
  return normalizeCreds(readJson(credFile(), null));
}

function saveStored(creds) {
  const out = { version: 2, clients: creds.clients || {}, token: creds.token || null };
  // 兼容字段：面板、日志、老代码按平铺字段读，写盘时一并带上
  const t = out.token || {};
  out.clientId = t.clientId || null;
  out.accessToken = t.accessToken || null;
  out.refreshToken = t.refreshToken || null;
  out.expiresAt = t.expiresAt || null;
  out.authorizedAt = t.authorizedAt || null;
  out.scope = t.scope || null;
  writeJson(credFile(), out);
  return out;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 带超时的 fetch：连 body 一起包进超时窗口。
 *
 * 为什么连 res.text() 也包：只给 fetch 加 signal，服务端收下请求却不吐 body 时，
 * res.text() 照样能挂到天荒地老——秀米侧挂住时，工具就卡死在这一步。
 *
 * opts.timeoutMs  覆盖 DEFAULT_TIMEOUT_MS
 * opts.signal     外部取消（调用方自己的 AbortSignal）
 * opts.label      报错里点得出是哪一步（"注册客户端" / "MCP tools/list"…）
 *
 * 超时 / 断网 / 取消都转成人话；超时错误带 code='XIUMI_TIMEOUT'。
 * HTTP 状态码不在这一层处理——原样交给调用方，别把 4xx/5xx 吞成"网络错误"。
 */
async function fetchText(url, init, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const label = opts.label || '秀米接口';
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  const external = opts.signal || null;
  const onAbort = () => ctrl.abort();
  if (external) {
    if (external.aborted) ctrl.abort();
    else external.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const res = await fetch(url, { ...(init || {}), signal: ctrl.signal });
    const text = await res.text();
    return { res, text };
  } catch (err) {
    if (external && external.aborted) {
      const error = new Error('「' + label + '」已取消，没有执行完。', { cause: err });
      error.code = 'XIUMI_ABORTED';
      throw error;
    }
    if (timedOut || ctrl.signal.aborted) {
      const error = new Error('连秀米超时：' + label + ' 等了 ' + timeoutMs / 1000 + ' 秒没有响应。检查网络或代理后再试。', { cause: err });
      error.code = 'XIUMI_TIMEOUT';
      error.timeoutMs = timeoutMs;
      throw error;
    }
    const raw = err && err.message ? String(err.message) : String(err);
    const error = new Error('连不上秀米：' + label + ' 网络不通（' + raw.slice(0, 160) + '）。检查网络或代理后再试。', { cause: err });
    error.code = 'XIUMI_NETWORK';
    throw error;
  } finally {
    clearTimeout(timer);
    if (external) external.removeEventListener('abort', onAbort);
  }
}

async function httpJson(url, init, opts = {}) {
  const { res, text } = await fetchText(url, init, { label: opts.label, timeoutMs: opts.timeoutMs, signal: opts.signal });
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  return { status: res.status, headers: res.headers, payload, text };
}

/** 为当前回调地址注册（或复用）一个公开客户端。端口变了就重新注册。 */
async function ensureClient(redirectUri, opts = {}) {
  const creds = storedCreds();
  const known = creds.clients[redirectUri];
  if (known && known.clientId) {
    return { clientId: known.clientId, redirectUri, reused: true };
  }
  const body = {
    client_name: CLIENT_NAME,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: SCOPE,
  };
  const out = await httpJson(REGISTER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  }, { label: '注册 OAuth 客户端', timeoutMs: opts.timeoutMs });
  if (out.status !== 200 && out.status !== 201) {
    throw new Error('秀米 OAuth 客户端注册失败（HTTP ' + out.status + '）：' + String(out.text).slice(0, 300));
  }
  const clientId = out.payload && (out.payload.client_id || out.payload.clientId);
  if (!clientId) throw new Error('注册响应里没有 client_id：' + String(out.text).slice(0, 300));
  const next = storedCreds();
  next.clients[redirectUri] = { clientId, createdAt: new Date().toISOString() };
  saveStored(next);
  return { clientId, redirectUri, reused: false };
}

/** 生成授权链接（同时把 PKCE verifier 落盘，回调时取回）。 */
export async function startAuthorization(redirectUri, opts = {}) {
  const { clientId } = await ensureClient(redirectUri, opts);
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  writeJson(pendingFile(), { verifier, state, redirectUri, clientId, at: Date.now() });
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    resource: RESOURCE,
  });
  return { url: AUTHORIZE_URL + '?' + q.toString(), state, clientId };
}

export async function finishAuthorization({ code, state }, opts = {}) {
  const pending = readJson(pendingFile(), null);
  if (!pending) throw new Error('没有待处理的授权（可能已过期，请重新点「连接秀米」）');
  if (state && pending.state && state !== pending.state) throw new Error('state 不匹配，拒绝这次回调');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: String(code),
    redirect_uri: pending.redirectUri,
    client_id: pending.clientId,
    code_verifier: pending.verifier,
    resource: RESOURCE,
  });
  const out = await httpJson(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
  }, { label: '换 token', timeoutMs: opts.timeoutMs });
  if (out.status !== 200 || !out.payload || !out.payload.access_token) {
    throw new Error('换 token 失败（HTTP ' + out.status + '）：' + String(out.text).slice(0, 300));
  }
  const creds = storedCreds();
  const expiresAt = Date.now() + (Number(out.payload.expires_in || 3600) - 60) * 1000;
  const token = {
    clientId: pending.clientId,
    redirectUri: pending.redirectUri,
    accessToken: out.payload.access_token,
    refreshToken: out.payload.refresh_token || (creds.token && creds.token.refreshToken) || null,
    scope: out.payload.scope || SCOPE,
    expiresAt,
    authorizedAt: new Date().toISOString(),
  };
  creds.token = token;
  saveStored(creds);
  const next = { ...token };
  try {
    fs.unlinkSync(pendingFile());
  } catch {
    /* ignore */
  }
  return next;
}

async function refreshToken(token, opts = {}) {
  if (!token || !token.refreshToken) return null;
  const clientId = token.clientId || currentClientId();
  if (!clientId) return null;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: token.refreshToken,
    client_id: clientId,
  });
  const out = await httpJson(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
  }, { label: '刷新 token', timeoutMs: opts.timeoutMs });
  // 刷新失败不抛：拿不到新 token 就当没授权，让上层提示重新连接
  if (out.status !== 200 || !out.payload || !out.payload.access_token) return null;
  const creds = storedCreds();
  const next = {
    ...token,
    clientId,
    accessToken: out.payload.access_token,
    refreshToken: out.payload.refresh_token || token.refreshToken,
    expiresAt: Date.now() + (Number(out.payload.expires_in || 3600) - 60) * 1000,
  };
  creds.token = next;
  saveStored(creds);
  return next;
}

/** 最近一次注册用的 client（旧凭证里可能没记 clientId）。 */
function currentClientId() {
  const creds = storedCreds();
  const entries = Object.values(creds.clients || {});
  if (!entries.length) return null;
  return entries[entries.length - 1].clientId || null;
}

export async function getAccessToken(opts = {}) {
  const creds = storedCreds();
  const token = creds.token;
  if (!token || !token.accessToken) return null;
  if (token.expiresAt && Date.now() > token.expiresAt) {
    const refreshed = await refreshToken(token, opts);
    if (refreshed) return refreshed.accessToken;
    return null;
  }
  return token.accessToken;
}

export function authorizationStatus() {
  const creds = storedCreds();
  const token = creds.token || {};
  return {
    connected: !!token.accessToken,
    clientId: token.clientId || null,
    authorizedAt: token.authorizedAt || null,
    expiresAt: token.expiresAt || null,
    hasRefresh: !!token.refreshToken,
    knownRedirects: Object.keys(creds.clients || {}),
  };
}

/** 解析 MCP 响应：可能是 application/json，也可能是 text/event-stream。 */
function parseMcpBody(text, contentType) {
  const type = String(contentType || '');
  if (type.includes('text/event-stream') || /^\s*(event|data):/m.test(text)) {
    const messages = [];
    for (const line of text.split(/\r?\n/)) {
      const m = /^data:\s*(.*)$/.exec(line);
      if (!m) continue;
      const raw = m[1].trim();
      if (!raw || raw === '[DONE]') continue;
      try {
        messages.push(JSON.parse(raw));
      } catch {
        /* 跳过非 JSON 心跳 */
      }
    }
    return messages.length ? messages[messages.length - 1] : null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

let rpcId = 0;
const SESSION = { id: null, initialized: false };

async function rpc(method, params, opts = {}) {
  const token = await getAccessToken({ timeoutMs: opts.timeoutMs });
  if (!token) {
    const error = new Error('还没有授权秀米：请在面板里点「连接秀米」完成一次登录授权');
    error.code = 'XIUMI_UNAUTHORIZED';
    throw error;
  }
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: 'Bearer ' + token,
  };
  if (SESSION.id) headers['mcp-session-id'] = SESSION.id;
  if (opts.protocolVersion) headers['mcp-protocol-version'] = opts.protocolVersion;
  const payload = { jsonrpc: '2.0', id: ++rpcId, method, params: params || {} };
  // 超时也在 opts 里传：tools/call 这种慢调用需要更长等待时，由调用方显式给 timeoutMs
  const { res, text } = await fetchText(
    MCP_URL,
    { method: 'POST', headers, body: JSON.stringify(payload) },
    { label: 'MCP ' + method, timeoutMs: opts.timeoutMs, signal: opts.signal }
  );
  const sid = res.headers.get('mcp-session-id');
  if (sid) SESSION.id = sid;
  if (res.status === 401) {
    const error = new Error('秀米授权已失效，请重新连接');
    error.code = 'XIUMI_UNAUTHORIZED';
    error.status = 401;
    throw error;
  }
  const message = parseMcpBody(text, res.headers.get('content-type'));
  if (!message) {
    const error = new Error('秀米 MCP 返回了看不懂的响应（HTTP ' + res.status + '）：' + String(text).slice(0, 300));
    error.code = 'XIUMI_BAD_RESPONSE';
    error.status = res.status; // 保留原始状态码，排障时不用再猜
    throw error;
  }
  if (message.error) {
    const error = new Error('MCP 错误 ' + (message.error.code || '') + '：' + (message.error.message || JSON.stringify(message.error)));
    error.rpcError = message.error;
    error.status = res.status;
    throw error;
  }
  if (!res.ok && message.result === undefined) {
    const error = new Error('秀米 MCP 返回 HTTP ' + res.status + '：' + String(text).slice(0, 300));
    error.code = 'XIUMI_HTTP_ERROR';
    error.status = res.status;
    throw error;
  }
  return message.result;
}

async function initialize(opts = {}) {
  if (SESSION.initialized) return SESSION;
  const result = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: { roots: { listChanged: false }, sampling: {} },
    clientInfo: { name: 'dsh-xiumi-studio', version: '0.1.0' },
  }, opts);
  SESSION.initialized = true;
  SESSION.serverInfo = result && result.serverInfo;
  SESSION.protocolVersion = result && result.protocolVersion;
  try {
    await fetchText(
      MCP_URL,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer ' + (await getAccessToken({ timeoutMs: opts.timeoutMs })),
          ...(SESSION.id ? { 'mcp-session-id': SESSION.id } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      },
      { label: 'MCP 初始化通知', timeoutMs: opts.timeoutMs }
    );
  } catch {
    /* 通知失败不影响后续调用 */
  }
  return SESSION;
}

export async function listTools(opts = {}) {
  await initialize(opts);
  const result = await rpc('tools/list', {}, opts);
  return (result && result.tools) || [];
}

export async function callTool(name, args, opts = {}) {
  await initialize(opts);
  const result = await rpc('tools/call', { name, arguments: args || {} }, opts);
  if (result && result.isError) {
    const text = (result.content || []).map((c) => c.text || '').join('\n');
    throw new Error('秀米工具 ' + name + ' 返回错误：' + text.slice(0, 600));
  }
  return result;
}


