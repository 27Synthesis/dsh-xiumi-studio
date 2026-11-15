import { getTheme } from './themes.mjs';

// 单引号字体栈：这段字符串会被塞进 style="…" 里，用双引号会把 HTML 属性提前截断（粘贴到秀米直接掉样式）
const FONT = "-apple-system,BlinkMacSystemFont,'Helvetica Neue','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif";

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}
function rgbToHex(rgb) {
  return '#' + rgb.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
/** 把 a 按比例混进 b，用来做浅色底（避免 opacity 在公众号里被吃掉） */
export function mix(a, b, ratio) {
  const A = hexToRgb(a), B = hexToRgb(b);
  return rgbToHex(A.map((v, i) => v * ratio + B[i] * (1 - ratio)));
}

function body(text) {
  return esc(text).replace(/\n/g, '<br />');
}

function sectionHeader(block, t) {
  const num = esc(block.number || '');
  const title = body(block.text);
  if (t.section === 'bar') {
    return '<section style="margin:36px 0 18px;padding-left:13px;border-left:3px solid ' + t.accent + ';">'
      + '<div style="font-size:11px;line-height:1;letter-spacing:3px;color:' + t.accent + ';margin-bottom:7px;">' + num + '</div>'
      + '<div style="font-size:18px;line-height:1.5;font-weight:700;letter-spacing:0.5px;color:' + t.ink + ';">' + title + '</div>'
      + '</section>';
  }
  if (t.section === 'ghost') {
    return '<section style="margin:38px 0 18px;">'
      + '<div style="font-size:40px;line-height:0.86;font-weight:800;color:' + mix(t.accent, t.paper, 0.22) + ';">' + num + '</div>'
      + '<div style="margin-top:-2px;font-size:18px;line-height:1.5;font-weight:700;letter-spacing:0.5px;color:' + t.ink + ';">' + title + '</div>'
      + '<div style="margin-top:11px;width:34px;height:2px;background:' + t.accent + ';"></div>'
      + '</section>';
  }
  if (t.section === 'pill') {
    return '<section style="margin:36px 0 18px;text-align:center;">'
      + '<span style="display:inline-block;padding:3px 11px;border-radius:999px;background:' + t.accentSoft + ';color:' + t.accent + ';font-size:11px;letter-spacing:2px;">' + num + '</span>'
      + '<div style="margin-top:9px;font-size:18px;line-height:1.5;font-weight:700;letter-spacing:0.5px;color:' + t.ink + ';">' + title + '</div>'
      + '<div style="margin:12px 22px 0;border-top:1px dashed ' + t.line + ';"></div>'
      + '</section>';
  }
  if (t.section === 'rule') {
    return '<section style="margin:38px 0 18px;">'
      + '<div style="height:1px;background:' + t.ink + ';"></div>'
      + '<div style="margin-top:9px;font-size:11px;line-height:1;letter-spacing:2px;color:' + t.sub + ';">' + num + '</div>'
      + '<div style="margin-top:6px;font-size:18px;line-height:1.5;font-weight:700;letter-spacing:0.5px;color:' + t.ink + ';">' + title + '</div>'
      + '</section>';
  }
  return '<section style="margin:36px 0 18px;">'
    + '<div style="display:inline-block;width:26px;height:26px;background:' + t.accent + ';color:' + t.onAccent + ';font-size:12px;line-height:26px;text-align:center;border-radius:3px;vertical-align:middle;letter-spacing:0;">' + num + '</div>'
    + '<div style="display:inline-block;vertical-align:middle;margin-left:10px;font-size:18px;line-height:1.5;font-weight:700;letter-spacing:0.5px;color:' + t.ink + ';">' + title + '</div>'
    + '<div style="margin-top:12px;height:1px;background:linear-gradient(90deg,' + t.accent + ' 0,' + t.accent + ' 18px,' + t.line + ' 18px,' + t.line + ' 100%);"></div>'
    + '</section>';
}

function imageBlock(block, t, ctx) {
  // 图有两种地址：本机 assetUrl（预览/导出用，能离线看图）和秀米图床 remoteUrl。
  // 要粘进秀米编辑器时必须用 remoteUrl —— 127.0.0.1 的图秀米服务器取不到，粘过去就是裂图。
  const src = (ctx.preferRemote && block.remoteUrl) || (ctx.assetUrl ? ctx.assetUrl(block.asset) : '') || '';
  if (!src) {
    // 缺图不许静默：宁可让缺口在页面上露出来，也不能悄悄少一张（硬约束：提供的图必须全部用上）
    return '<section style="margin:22px 0;padding:14px 16px;border:1px dashed ' + t.accent + ';border-radius:' + t.radius + ';text-align:center;">'
      + '<div style="font-size:12px;line-height:1.8;color:' + t.accent + ';">⚠ 这里缺一张图：' + esc(block.asset || '（没写素材名）') + '</div>'
      + '</section>';
  }
  const radius = t.radius;
  const shadow = t.shadow.img;   // 素白在 themes.mjs 里把这一道关掉（'none'）
  const hero = ctx.heroAsset && ctx.heroAsset === block.asset;
  const cap = block.caption;
  return '<section style="margin:' + (hero ? '26px 0 24px' : '22px 0') + ';">'
    + '<img src="' + esc(src) + '" style="display:block;width:100%;height:auto;border-radius:' + radius + ';box-shadow:' + shadow + ';" />'
    + (cap ? '<div style="margin-top:8px;font-size:11.5px;line-height:1.6;color:' + t.sub + ';text-align:center;">' + body(cap) + '</div>' : '')
    + '</section>';
}

/**
 * 表格（Word 里的获奖名单这类）：模板组件里没有表格，就用纯内联样式的 <table> 画一个，
 * 表头用主题色、正文隔行浅底、四边细线——粘到秀米/公众号里不会掉样式。
 */
function tableBlock(block, t) {
  const rows = (Array.isArray(block.rows) ? block.rows : []).filter((r) => Array.isArray(r) && r.length);
  if (!rows.length) return '';
  const header = Array.isArray(block.header) && block.header.length ? block.header : null;
  const sameAsFirst = header && rows[0].length === header.length && rows[0].every((c, i) => String(c) === String(header[i]));
  const headRow = header || null;
  const bodyRows = headRow ? rows.slice(1) : rows;
  const cols = rows.reduce((n, r) => Math.max(n, r.length), 0);
  const pad = (r) => {
    const cells = [];
    for (let i = 0; i < cols; i += 1) cells.push(String(r[i] == null ? '' : r[i]));
    return cells;
  };
  const th = headRow
    ? '<tr>' + pad(headRow).map((c) => '<th style="padding:9px 8px;border:1px solid ' + t.accent + ';background:' + t.accent + ';color:' + t.onAccent + ';font-size:12.5px;line-height:1.6;font-weight:700;letter-spacing:0.5px;text-align:center;">' + body(c) + '</th>').join('') + '</tr>'
    : '';
  const tb = bodyRows.map((r, i) => '<tr>' + pad(r).map((c) => '<td style="padding:9px 8px;border:1px solid ' + t.line + ';background:' + (i % 2 ? t.accentSoft : t.paper) + ';color:' + t.ink + ';font-size:12.5px;line-height:1.7;text-align:center;">' + body(c) + '</td>').join('') + '</tr>').join('');
  return '<section style="margin:22px 0 26px;overflow-x:auto;">'
    + '<table style="width:100%;border-collapse:collapse;font-family:' + FONT + ';">'
    + (th ? '<thead>' + th + '</thead>' : '')
    + '<tbody>' + tb + '</tbody></table>'
    + (block.caption ? '<div style="margin-top:8px;font-size:11.5px;line-height:1.6;color:' + t.sub + ';text-align:center;">' + body(block.caption) + '</div>' : '')
    + '</section>';
}

export function renderBlocks(project, opts = {}) {
  const t = getTheme(project.theme || 'zhusha');
  const ctx = { assetUrl: opts.assetUrl, heroAsset: opts.heroAsset, preferRemote: !!opts.preferRemote };
  const out = [];
  const blocks = project.blocks || [];
  let seenTitle = false;

  for (const b of blocks) {
    switch (b.type) {
      case 'kicker':
        if (b.text) {
          out.push('<section style="margin:0 0 10px;text-align:center;">'
            + '<span style="display:inline-block;padding:0 10px;border-left:1px solid ' + t.accent + ';border-right:1px solid ' + t.accent + ';color:' + t.accent + ';font-size:11px;line-height:1.9;letter-spacing:3px;">' + body(b.text) + '</span>'
            + '</section>');
        }
        break;
      case 'title':
        seenTitle = true;
        out.push('<h1 style="margin:0 0 10px;font-size:23px;line-height:1.52;font-weight:700;letter-spacing:0.5px;color:' + t.ink + ';text-align:center;">' + body(b.text) + '</h1>');
        out.push('<div style="margin:0 auto 16px;width:34px;height:2px;background:' + t.accent + ';"></div>');
        break;
      case 'subtitle':
        out.push('<p style="margin:0 0 26px;font-size:13px;line-height:1.75;color:' + t.sub + ';letter-spacing:0.4px;text-align:center;">' + body(b.text) + '</p>');
        break;
      case 'lead':
        out.push('<section style="margin:24px 0 26px;padding:16px 18px;background:' + t.accentSoft + ';border-left:3px solid ' + t.accent + ';border-radius:' + t.radius + ';">'
          + '<p style="margin:0;font-size:14.5px;line-height:1.95;letter-spacing:0.3px;color:' + t.ink + ';text-align:justify;">' + body(b.text) + '</p>'
          + '</section>');
        break;
      case 'section':
        out.push(sectionHeader(b, t));
        break;
      case 'image':
        out.push(imageBlock(b, t, ctx));
        break;
      case 'quote':
        out.push('<section style="margin:24px 0;padding:18px 20px;background:' + t.accentSoft + ';border-radius:' + t.radius + ';">'
          + '<p style="margin:0;font-size:14.5px;line-height:1.9;color:' + mix(t.ink, t.paper, 0.85) + ';text-align:justify;">' + body(b.text) + '</p>'
          + '</section>');
        break;
      case 'list':
        out.push('<section style="margin:0 0 12px;padding-left:14px;">'
          + '<span style="display:inline-block;width:5px;height:5px;border-radius:50%;background:' + t.accent + ';vertical-align:middle;margin-right:8px;"></span>'
          + '<span style="font-size:15.5px;line-height:1.9;color:' + t.ink + ';">' + body(b.text) + '</span>'
          + '</section>');
        break;
      case 'divider':
        out.push('<div style="margin:30px 0;height:1px;background:' + t.line + ';"></div>');
        break;
      case 'end':
        out.push('<section style="margin:40px 0 6px;text-align:center;">'
          + '<div style="font-size:0;line-height:0;">'
          + '<span style="display:inline-block;width:5px;height:5px;border-radius:50%;background:' + t.accent + ';margin:0 3px;"></span>'
          + '<span style="display:inline-block;width:5px;height:5px;border-radius:50%;background:' + mix(t.accent, t.paper, 0.55) + ';margin:0 3px;"></span>'
          + '<span style="display:inline-block;width:5px;height:5px;border-radius:50%;background:' + mix(t.accent, t.paper, 0.28) + ';margin:0 3px;"></span>'
          + '</div>'
          + '<div style="margin-top:12px;font-size:10px;line-height:1;letter-spacing:6px;color:' + t.sub + ';">' + body(b.text || 'END') + '</div>'
          + '</section>');
        break;
      case 'table':
        out.push(tableBlock(b, t));
        break;
      case 'signature':
        out.push('<section style="margin:34px 0 4px;text-align:right;">'
          + '<div style="font-size:12px;line-height:1.8;color:' + t.sub + ';letter-spacing:0.5px;">' + body(b.text) + '</div>'
          + '</section>');
        break;
      default:
        out.push('<p style="margin:0 0 18px;font-size:15.5px;line-height:1.95;letter-spacing:0.3px;color:' + t.ink + ';text-align:justify;">' + body(b.text) + '</p>');
    }
  }
  if (!seenTitle && project.title) {
    out.unshift('<h1 style="margin:0 0 16px;font-size:23px;line-height:1.52;font-weight:700;color:' + t.ink + ';text-align:center;">' + body(project.title) + '</h1>');
  }
  return out.join('\n');
}

export function countStats(project) {
  const blocks = project.blocks || [];
  const chars = blocks.filter(b => b.text).reduce((n, b) => n + String(b.text).replace(/\s/g, '').length, 0);
  const images = blocks.filter(b => b.type === 'image').length;
  const sections = blocks.filter(b => b.type === 'section').length;
  return { chars, images, sections, blocks: blocks.length };
}

export function renderPage(project, opts = {}) {
  const t = getTheme(project.theme || 'zhusha');
  const inner = renderBlocks(project, opts);
  const article = '<div style="background:' + t.paper + ';padding:28px 20px 38px;font-family:' + FONT + ';">' + inner + '</div>';
  const page = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8" />'
    + '<meta name="viewport" content="width=device-width,initial-scale=1" />'
    + '<title>' + esc(project.title || '图文预览') + '</title>'
    + '<style>html,body{margin:0;padding:0;}body{background:' + t.shellBg + ';padding:18px 10px 40px;}'
    + '.xm-phone{max-width:390px;margin:0 auto;background:' + t.paper + ';box-shadow:' + t.shadow.phone + ';border-radius:14px;overflow:hidden;}'
    + 'img{max-width:100%;}</style></head><body><div class="xm-phone">' + article + '</div></body></html>';
  return { article, page, theme: t };
}

const COLUMN_MAX = 677;   // 公众号正文最大宽度：预览、导出、复制到秀米共用这一个数

/**
 * 导出 / 直接双击打开用的完整 HTML。
 * 只有这一个外壳：正文还是 renderFragment，导出、复制、预览三者的正文逐字节相同（PRINCIPLES §3）。
 */
export function renderStandalone(project, opts = {}) {
  const t = getTheme(project.theme || 'zhusha');
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8" />'
    + '<meta name="viewport" content="width=device-width,initial-scale=1" />'
    + '<title>' + esc(project.title || '图文') + '</title>'
    + '<style>html,body{margin:0;padding:0;}'
    + 'body{background:' + t.wash + ';padding:22px 10px 46px;}'
    + '.xm-sheet{max-width:' + COLUMN_MAX + 'px;margin:0 auto;box-shadow:' + t.shadow.sheet + ';}'
    + 'img{max-width:100%;}</style></head><body><div class="xm-sheet">'
    + renderFragment(project, opts) + '</div></body></html>';
}

/** 微信侧只需要「带内联样式的片段」 */
export function renderFragment(project, opts = {}) {
  const t = getTheme(project.theme || 'zhusha');
  return '<div style="background:' + t.paper + ';padding:28px 20px 38px;font-family:' + FONT + ';">'
    + renderBlocks(project, opts) + '</div>';
}
