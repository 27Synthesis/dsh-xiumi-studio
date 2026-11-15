/**
 * 秀米免费模板目录：拉取 + 缓存 + 本地检索（Q2 方案 A 的地基）。
 *
 * 为什么不走 MCP：2026-11 侦察确认秀米 MCP 只暴露「列出我的内容 / 查详情 / 打标签 /
 * 改文字 / 管图库」五类能力，没有任何 template / search 工具（见 _inspect/research-templates.md 第 2 节）。
 * 但模板商店的列表接口是免登录的，所以模板目录可以在本地自建。
 *
 * 三条硬约束都是实测出来的，别改：
 *   1. 列表里混着付费模板 -> 必须硬过滤 price !== 0，否则会踩付费模板的授权坑；
 *   2. 匿名用户 page >= 18 直接 401 -> 翻页要能在 401 处优雅停，把已拿到的存下来；
 *   3. 单页最多 72 条，但 12 条/页最稳 -> 一次翻 18 页正好 216 条，是匿名能拿到的上限。
 *
 * 本模块不碰 ctx、不发通知、不改工程数据，只做「拉一份目录放进用户级缓存」。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const GOODS_URL = 'https://xiumi.us/api/show_goods/goodses';
export const PAGE_SIZE = 12;
export const ANON_MAX_PAGES = 18;
export const ANON_MAX_ITEMS = 216;
export const TTL_MS = 24 * 60 * 60 * 1000;
export const CATALOG_VERSION = 1;

const FETCH_TIMEOUT_MS = 15000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const STUDIO_REFERER = 'https://xiumi.us/studio';

/** 模板目录的网络/接口错误。message 一定是人话，不含 token、不含 cookie。 */
export class TemplateFetchError extends Error {
  constructor(message, opts) {
    super(message, opts && opts.cause ? { cause: opts.cause } : undefined);
    this.name = 'TemplateFetchError';
    this.code = (opts && opts.code) || 'fetch_failed';
    this.page = opts && Number.isInteger(opts.page) ? opts.page : null;
    this.status = (opts && opts.status) || null;
  }
}

/** XIUMI_HOME 只给自测用，和 host/mcp.mjs 用同一个环境变量，测试不会写到真账号目录。 */
function homeDir() {
  return process.env.XIUMI_HOME || path.join(os.homedir(), '.dsh', 'xiumi');
}

export function catalogFile() {
  return path.join(homeDir(), 'templates.json');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** 秀米给的是 //img.xiumi.us/...，浏览器能认，Node/前端拼 URL 时要补协议。 */
function toHttps(url) {
  const s = String(url == null ? '' : url).trim();
  if (!s) return '';
  return s.startsWith('//') ? 'https:' + s : s;
}

/**
 * 把秀米的一条 goods 拍平成本目录要用的形状。
 * 只留这 8 个字段：目录 UI 和检索都够用，多余字段留着只会让缓存膨胀。
 */
export function normalizeItem(raw) {
  const show = (raw && raw.show) || {};
  const seller = (raw && raw.seller) || {};
  return {
    id: raw.show_goods_id == null ? show.show_id : raw.show_goods_id,
    title: String(show.title || '').trim(),
    cover: toHttps(show.cover),
    author: String(seller.nickname || '').trim(),
    copies: Number(raw.free_copy_number || 0),
    showUrl: toHttps(show.show_url),
    editUrl: String(show.edit_url || ''),
    price: Number(raw.price == null ? 0 : raw.price),
  };
}

/**
 * 抓一页免费图文模板（免登录）。
 *
 * 返回 { items, hasMore, total, filtered }：
 *   items    已按 price === 0 过滤、已规整的条目
 *   hasMore  还能不能再翻（按服务端 count 推的，不是按过滤后的条数）
 *   total    服务端报的免费图文模板总数
 *   filtered 这一页被过滤掉的付费条目数（给日志用，别当错误）
 *
 * 失败一律抛 TemplateFetchError；401 的 code 是 auth_required，让 refreshCatalog 优雅收尾。
 */
export async function fetchFreePage(page, opts) {
  const options = opts || {};
  const p = Number(page);
  if (!Number.isInteger(p) || p < 0) {
    throw new TemplateFetchError('页码不合法：' + String(page) + '（要 0 或正整数）', { code: 'bad_page' });
  }

  const url =
    GOODS_URL +
    '?show_type=paper&price_scope=free&page=' + p +
    '&limit=' + PAGE_SIZE +
    '&by_nearest=0&tpl_flag=0';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  const external = options.signal;
  const onAbort = () => ctrl.abort();
  if (external) {
    if (external.aborted) ctrl.abort();
    else external.addEventListener('abort', onAbort, { once: true });
  }

  let res;
  try {
    res = await fetch(url, {
      headers: {
        'user-agent': UA,
        accept: 'application/json',
        referer: STUDIO_REFERER,
        origin: 'https://xiumi.us',
      },
      signal: ctrl.signal,
    });
  } catch (err) {
    if (external && external.aborted) {
      throw new TemplateFetchError('拉取秀米模板列表被取消（第 ' + p + ' 页）', { code: 'aborted', page: p, cause: err });
    }
    if (ctrl.signal.aborted) {
      throw new TemplateFetchError(
        '拉取秀米模板列表超时（第 ' + p + ' 页，' + FETCH_TIMEOUT_MS / 1000 + ' 秒）。检查网络或代理后再试。',
        { code: 'timeout', page: p, cause: err }
      );
    }
    throw new TemplateFetchError('拉取秀米模板列表失败（第 ' + p + ' 页）：网络不可达。检查网络或代理后再试。', {
      code: 'network',
      page: p,
      cause: err,
    });
  } finally {
    clearTimeout(timer);
    if (external) external.removeEventListener('abort', onAbort);
  }

  if (res.status === 401) {
    throw new TemplateFetchError(
      '秀米把匿名翻页拦住了（第 ' + p + ' 页返回 401）：匿名只能看前 ' + ANON_MAX_ITEMS + ' 个免费模板，已拿到的部分可以继续用。',
      { code: 'auth_required', page: p, status: 401 }
    );
  }
  if (!res.ok) {
    throw new TemplateFetchError('拉取秀米模板列表失败（第 ' + p + ' 页）：秀米返回 HTTP ' + res.status + '。', {
      code: 'http_error',
      page: p,
      status: res.status,
    });
  }

  let body;
  try {
    body = await res.json();
  } catch (err) {
    throw new TemplateFetchError(
      '拉取秀米模板列表失败（第 ' + p + ' 页）：返回的不是 JSON，可能被登录墙或代理拦了。',
      { code: 'bad_json', page: p, cause: err }
    );
  }
  if (!body || body.code !== 0 || !body.data) {
    const message = (body && body.message) || '未知错误';
    throw new TemplateFetchError('秀米模板列表返回业务错误（第 ' + p + ' 页）：' + message, {
      code: 'api_error',
      page: p,
    });
  }

  const rawItems = Array.isArray(body.data.goodses) ? body.data.goodses : [];
  const total = Number(body.data.count) || 0;
  const items = rawItems.map(normalizeItem).filter((it) => it.price === 0);
  const totalPages = total > 0 ? Math.ceil(total / PAGE_SIZE) : 0;
  const hasMore = rawItems.length >= PAGE_SIZE && (totalPages === 0 ? true : p + 1 < totalPages);
  return { items, hasMore, total, filtered: rawItems.length - items.length };
}
/**
 * 刷新整份目录：从第 0 页一直翻，直到没得翻 / 拿满 216 条 / 碰到 401 为止，然后落盘。
 *
 * 返回 { version, fetchedAt, count, items, stoppedReason, pagesFetched }：
 *   stoppedReason: has_more_false | max_items | max_pages | anonymous_limit | stopped_on_error
 *
 * 第 0 页就失败会直接抛（不要假装拿到空目录）；后续某一页失败则保留已拿到的部分，
 * 用 stoppedReason=stopped_on_error + lastError 说明原因，下一次刷新会重来。
 */
export async function refreshCatalog(opts) {
  const options = opts || {};
  const maxPages = Number.isInteger(options.maxPages) && options.maxPages > 0 ? options.maxPages : ANON_MAX_PAGES;
  const maxItems = Number.isInteger(options.maxItems) && options.maxItems > 0 ? options.maxItems : ANON_MAX_ITEMS;

  const items = [];
  const seen = new Set();
  let pagesFetched = 0;
  let stoppedReason = null;
  let lastError = null;

  for (let page = 0; page < maxPages; page += 1) {
    if (items.length >= maxItems) {
      stoppedReason = 'max_items';
      break;
    }

    let data;
    try {
      data = await fetchFreePage(page, { signal: options.signal });
    } catch (err) {
      if (err && err.code === 'auth_required') {
        stoppedReason = 'anonymous_limit';
        break;
      }
      if (page === 0) throw err;
      lastError = err && err.message ? err.message : String(err);
      stoppedReason = 'stopped_on_error';
      break;
    }

    pagesFetched += 1;
    for (const it of data.items) {
      const key = String(it.id);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(it);
      if (items.length >= maxItems) break;
    }
    // 匿名抓满 216 条就等于撞上未登录的天花板，如实标注，别让调用方以为是「翻页翻够了」
    if (items.length >= ANON_MAX_ITEMS) {
      stoppedReason = 'anonymous_limit';
      break;
    }
    if (!data.hasMore) {
      stoppedReason = 'has_more_false';
      break;
    }
  }

  if (!stoppedReason) stoppedReason = 'max_pages';

  const catalog = {
    version: CATALOG_VERSION,
    fetchedAt: new Date(Number(options.now) || Date.now()).toISOString(),
    count: items.length,
    items,
    stoppedReason,
    pagesFetched,
  };
  if (lastError) catalog.lastError = lastError;

  writeJson(options.file || catalogFile(), catalog);
  return catalog;
}

/**
 * 读缓存目录。没有文件 / 读不动 / 超过 24h 都返回 null（调用方据此决定要不要 refresh）。
 */
export function readCatalog(opts) {
  const options = opts || {};
  const now = Number(options.now) || Date.now();
  const raw = readJson(options.file || catalogFile(), null);
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) return null;
  const fetched = Date.parse(raw.fetchedAt);
  if (!Number.isFinite(fetched)) return null;
  if (now - fetched > TTL_MS) return null;
  return raw;
}

/**
 * 纯本地检索：标题或作者包含 q 就算命中；q 为空则给前 limit 条。
 * 不联网、不抛错，参数不合法就返回空数组。
 */
export function searchCatalog(items, opts) {
  const options = opts || {};
  const list = Array.isArray(items) ? items : [];

  let limit = Number(options.limit);
  if (!Number.isFinite(limit)) limit = 20;
  limit = Math.floor(limit);
  if (limit <= 0) return [];

  const q = String(options.q == null ? '' : options.q).trim().toLowerCase();
  if (!q) return list.slice(0, limit);

  const out = [];
  for (const it of list) {
    const title = String(it && it.title ? it.title : '').toLowerCase();
    const author = String(it && it.author ? it.author : '').toLowerCase();
    if (title.includes(q) || author.includes(q)) {
      out.push(it);
      if (out.length >= limit) break;
    }
  }
  return out;
}
