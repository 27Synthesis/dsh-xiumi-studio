/**
 * 把本地工程发布到秀米「我的图文」。
 *
 * 设计原则（对着长图第 2 条「方案要让人看懂」）：**不猜接口**。
 * 秀米 MCP 的工具 schema 只有拿到真实授权后才看得见，所以这里不硬编码参数名，
 * 而是运行时读 tools/list 的 inputSchema，按字段名/类型挑能装得下的形态：
 *   - 要 html / content / rich_text  → 我们渲染好的内联样式 HTML
 *   - 要 markdown / md              → 由 blocks 反推的 Markdown
 *   - 要 plan / blocks / sections   → 结构化块数组
 * 装不上就明确报错并把 schema 一起抛出来，绝不假装成功。
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as mcp from './mcp.mjs';
import { renderFragment } from './render.mjs';

const HTML_KEYS = ['html', 'content', 'rich_text', 'richtext', 'body', 'article', 'template'];
const MD_KEYS = ['markdown', 'md', 'text', 'source'];
const PLAN_KEYS = ['plan', 'blocks', 'sections', 'items', 'nodes', 'structure', 'elements'];

export function blocksToMarkdown(project) {
  const lines = [];
  for (const b of project.blocks || []) {
    const text = String(b.text == null ? '' : b.text).trim();
    if (b.type === 'title') lines.push('# ' + text, '');
    else if (b.type === 'subtitle') lines.push('**' + text + '**', '');
    else if (b.type === 'section') lines.push('## ' + text, '');
    else if (b.type === 'lead') lines.push('> ' + text, '');
    else if (b.type === 'quote') lines.push('> ' + text, '');
    else if (b.type === 'image') lines.push('![' + (b.caption || b.alt || '图片') + '](' + (b.remoteUrl || b.url || '') + ')', '');
    else if (b.type === 'list') lines.push('- ' + text);
    else if (b.type === 'divider') lines.push('---', '');
    else if (b.type === 'end') lines.push('', '---', '');
    else if (text) lines.push(text, '');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

// 只有本模块的 buildArgsForTool 用；外面没有调用点，不 export（PRINCIPLES §4）。
function blocksToPlan(project) {
  const font = { body: 15, heading: 18, title: 23 };
  return (project.blocks || []).map((b, i) => ({
    id: b.id || 'b' + i,
    type: b.type,
    text: b.text || '',
    number: b.number || '',
    image: b.type === 'image' ? { url: b.remoteUrl || null, local: b.asset || null, caption: b.caption || '' } : undefined,
  }));
}

function pickByKey(schemaProps, keys) {
  for (const k of keys) {
    if (schemaProps && Object.prototype.hasOwnProperty.call(schemaProps, k)) return k;
  }
  return null;
}

/** 按真实 schema 组装参数。返回 {args, used}，装不下时抛错并附 schema。 */
export function buildArgsForTool(tool, project, opts = {}) {
  const schema = (tool && tool.inputSchema) || { properties: {} };
  const props = schema.properties || {};
  const required = schema.required || [];
  const args = {};
  const used = [];

  const titleKey = pickByKey(props, ['title', 'name', 'subject']);
  if (titleKey) {
    args[titleKey] = project.title || '未命名图文';
    used.push(titleKey);
  }

  const htmlKey = pickByKey(props, HTML_KEYS);
  const mdKey = pickByKey(props, MD_KEYS);
  const planKey = pickByKey(props, PLAN_KEYS);

  if (htmlKey && (!mdKey || opts.prefer === 'html')) {
    args[htmlKey] = opts.html || renderFragment(project);
    used.push(htmlKey);
  }
  if (mdKey && !args[mdKey] && (!htmlKey || opts.prefer === 'markdown')) {
    args[mdKey] = blocksToMarkdown(project);
    used.push(mdKey);
  }
  if (planKey && !args[planKey]) {
    args[planKey] = blocksToPlan(project);
    used.push(planKey);
  }

  // 其余必填字段：能安全填的填（布尔给 true、字符串给标题），填不了就交给上层报错
  for (const key of required) {
    if (args[key] !== undefined) continue;
    if (key === titleKey) continue;
    const prop = props[key] || {};
    if (prop.enum && prop.enum.length) {
      args[key] = prop.enum[0];
      used.push(key + '(enum)');
    } else if (prop.type === 'boolean') {
      args[key] = false;
      used.push(key);
    } else if (prop.type === 'string') {
      args[key] = key === 'summary' || key === 'digest' ? (project.subtitle || '') : '';
      used.push(key);
    }
  }

  const missing = required.filter((k) => args[k] === undefined);
  if (missing.length) {
    const error = new Error('这个秀米工具需要我们没有的字段：' + missing.join(', '));
    error.schema = schema;
    throw error;
  }
  return { args, used };
}

/** 列出秀米侧可用工具及其 schema（面板「接口」页与排障都用得到）。 */
export async function describeRemote(opts = {}) {
  const tools = await mcp.listTools({ timeoutMs: opts.timeoutMs });
  return tools.map((t) => ({
    name: t.name,
    title: t.title || t.annotations && t.annotations.title || '',
    description: String(t.description || '').slice(0, 400),
    required: (t.inputSchema && t.inputSchema.required) || [],
    properties: Object.keys((t.inputSchema && t.inputSchema.properties) || {}),
  }));
}

/** 秀米 MCP 的工具清单落盘：授权后第一次跑，就把真实名字与 schema 存成文件——
 *  以后改适配不用再猜，也不用把它塞进上下文。 */
export function dumpTools(tools) {
  try {
    const dir = path.join(os.homedir(), '.dsh', 'xiumi');
    // 这个目录里放着 oauth.json（明文 token）：谁先建都得是 0o700。
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* Windows 没有 POSIX 权限位，收不拢不影响落盘 */
    }
    const file = path.join(dir, 'mcp-tools.json');
    const slim = (tools || []).map((t) => ({
      name: t.name,
      title: t.title || null,
      description: String(t.description || '').slice(0, 800),
      inputSchema: t.inputSchema || null,
    }));
    writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), count: slim.length, tools: slim }, null, 2), 'utf8');
    return file;
  } catch {
    return null;
  }
}

/** 发布前体检：把「会在秀米那边出丑」的情况提前说清楚，而不是发出去再回来看裂图。 */
export function preflightPublish(project, opts = {}) {
  const blocks = project.blocks || [];
  const issues = [];
  if (!blocks.length) issues.push({ level: 'block', code: 'EMPTY', msg: '这篇工程里没有内容块。' });
  const usedAssets = new Set(blocks.filter((b) => b.type === 'image').map((b) => b.asset));
  const unused = (project.assets || []).filter((a) => !usedAssets.has(a.name)).map((a) => a.name);
  if (unused.length) issues.push({ level: 'warn', code: 'UNUSED_ASSETS', msg: '这些素材没用上：' + unused.join('、') + '（要求提供的图必须全部用上）。' });
  const imgs = blocks.filter((b) => b.type === 'image');
  const localOnly = imgs.filter((b) => !b.remoteUrl).length;
  const origin = String(opts.origin || '');
  const loopback = !origin || /127\.0\.0\.1|localhost|\[::1\]/.test(origin);
  if (imgs.length && localOnly && loopback) {
    issues.push({
      level: opts.allowLocalImages ? 'warn' : 'block',
      code: 'LOCAL_IMAGES',
      msg: '有 ' + localOnly + ' 张图只有本机地址（' + (origin || '未取到宿主地址') + '），秀米服务器取不到，直接投递会裂图。两条路：①面板「复制到秀米」，在秀米编辑器里粘贴（图由秀米自己上传）；②授权后用秀米图库工具把图传上去换 CDN 地址再发。'
    });
  }
  if (!project.cover) issues.push({ level: 'warn', code: 'NO_COVER', msg: '还没有封面；先在面板按「重新生成封面」。' });
  return { ok: !issues.some((i) => i.level === 'block'), issues };
}

const CREATE_HINTS = ['create_show_from_plan', 'create_show', 'create_article', 'publish', 'import'];

export async function publishProject(project, opts = {}) {
  // tools/call 可能比列工具慢得多：要更长的等待就由调用方给 opts.timeoutMs（默认仍是 15 秒）
  const tools = await mcp.listTools({ timeoutMs: opts.timeoutMs });
  const dumpPath = dumpTools(tools);
  const byName = new Map(tools.map((t) => [t.name, t]));
  let tool = null;
  for (const hint of CREATE_HINTS) {
    const hit = tools.find((t) => t.name === hint) || tools.find((t) => t.name.includes(hint));
    if (hit) {
      tool = hit;
      break;
    }
  }
  if (!tool) {
    const error = new Error('秀米侧没有创建图文的工具。可用工具：' + tools.map((t) => t.name).join(', ') + (dumpPath ? '（完整 schema 已存到 ' + dumpPath + '）' : ''));
    error.tools = tools.map((t) => ({ name: t.name, description: t.description }));
    error.dumpPath = dumpPath;
    throw error;
  }
  const built = buildArgsForTool(tool, project, {
    html: opts.html || renderFragment(project),
    prefer: opts.prefer || 'html',
  });
  const result = await mcp.callTool(tool.name, built.args, { timeoutMs: opts.timeoutMs });
  const text = (result.content || []).map((c) => c.text || '').filter(Boolean).join('\n');
  let structured = result.structuredContent || null;
  return { tool: tool.name, used: built.used, result, text, structured };
}

/**
 * 把工程里的每张图传进秀米图库，换回图床地址（写进 block.remoteUrl）。
 *
 * 为什么非要走这一步：秀米 MCP **没有「新建图文」的工具**（12 个工具里只有 create_image，
 * 其余是读作品、改已有作品文字、管理图库）。所以「直接出现在我的图文」只能靠
 * 「渲染 HTML → 剪贴板 → 秀米编辑器粘贴 → 保存」这条路，而粘贴时图片必须是秀米取得到的地址。
 * 127.0.0.1 的地址它取不到，必须先在秀米图床上有一份。
 *
 * 参数：readAsset(name) → Buffer|null（调用方负责读本地素材文件）。
 * 返回：{ uploaded:[{name,url}], skipped:[name], failed:[{name,error}] }；成功的那部分已写回 blocks。
 */
export async function uploadProjectAssets(project, opts = {}) {
  const readAsset = typeof opts.readAsset === 'function' ? opts.readAsset : () => null;
  const blocks = (project.blocks || []).filter((b) => b.type === 'image' && b.asset);
  const names = [];
  for (const b of blocks) if (names.indexOf(b.asset) < 0) names.push(b.asset);

  const known = new Map();
  for (const b of blocks) if (b.remoteUrl) known.set(b.asset, b.remoteUrl);

  const out = { uploaded: [], skipped: [], failed: [] };
  for (const name of names) {
    if (known.has(name)) {
      out.skipped.push(name);
      continue;
    }
    const buf = readAsset(name);
    if (!buf || !buf.length) {
      out.failed.push({ name, error: '素材文件不在盘上' });
      continue;
    }
    try {
      const result = await mcp.callTool('create_image', { image_base64: Buffer.from(buf).toString('base64') }, { timeoutMs: opts.timeoutMs || 120000 });
      const url = pickImageUrl(result);
      if (!url) {
        out.failed.push({ name, error: '秀米没回图床地址' });
        continue;
      }
      known.set(name, url);
      out.uploaded.push({ name, url });
    } catch (error) {
      out.failed.push({ name, error: error.message });
    }
  }
  for (const b of project.blocks || []) {
    if (b && b.type === 'image' && b.asset && known.has(b.asset)) b.remoteUrl = known.get(b.asset);
  }
  return out;
}

/** 秀米回的 target_uri 是协议相对地址（`//img.xiumi.us/...`）：补成 https，否则 <img src> 在导出文件里会指回本地。 */
function normalizeUrl(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  if (s.startsWith('//')) return 'https:' + s;
  if (/^https?:\/\//i.test(s)) return s;
  return '';
}

/** create_image 的返回是 MCP 文本 + 可能的结构化内容：把图床地址找出来，不猜死字段名。 */
function pickImageUrl(result) {
  const texts = ((result && result.content) || []).map((c) => (c && c.text) || '').filter(Boolean).join('\n');
  const probes = [texts, JSON.stringify((result && result.structuredContent) || {})];
  for (const probe of probes) {
    if (!probe) continue;
    try {
      const hit = deepFindUrl(JSON.parse(probe));
      if (hit) return hit;
    } catch {
      /* 不是 JSON，往下走正则 */
    }
    const m = probe.match(/"?target_uri"?\s*[:=]\s*"?([^\s"'<>),]+)/i)
      || probe.match(/"?(?:url|image_url|src)"?\s*[:=]\s*"?((?:https?:)?\/\/[^\s"'<>),]+)/i)
      || probe.match(/(?:https?:)?\/\/[^\s"'<>)]+\.(?:png|jpe?g|gif|webp|svg)[^\s"'<>)]*/i);
    const norm = m && normalizeUrl(m[1] || m[0]);
    if (norm) return norm;
  }
  return '';
}

function deepFindUrl(node, depth = 0) {
  if (!node || depth > 6) return '';
  if (typeof node === 'string') {
    const norm = normalizeUrl(node);
    return norm && /\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(norm) ? norm : '';
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = deepFindUrl(item, depth + 1);
      if (hit) return hit;
    }
    return '';
  }
  if (typeof node === 'object') {
    for (const key of ['target_uri', 'url', 'image_url', 'src']) {
      const norm = normalizeUrl(node[key]);
      if (norm) return norm;
    }
    for (const value of Object.values(node)) {
      const hit = deepFindUrl(value, depth + 1);
      if (hit) return hit;
    }
  }
  return '';
}
