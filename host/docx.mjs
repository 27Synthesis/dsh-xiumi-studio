import { readFileSync } from 'node:fs';
import { readZip } from './zip.mjs';

const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXml(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITY[body] !== undefined ? ENTITY[body] : m;
  });
}

function attr(xml, name) {
  const m = xml.match(new RegExp(name + '="([^"]*)"'));
  return m ? decodeXml(m[1]) : '';
}

function parseRels(xml) {
  const map = new Map();
  const re = /<Relationship\b[^>]*>/g;
  let m;
  while ((m = re.exec(xml))) {
    const tag = m[0];
    const id = attr(tag, 'Id');
    const target = attr(tag, 'Target');
    const type = attr(tag, 'Type');
    if (id) map.set(id, { target, type });
  }
  return map;
}

function parseStyles(xml) {
  const map = new Map();
  if (!xml) return map;
  const re = /<w:style\b[^>]*>[\s\S]*?<\/w:style>/g;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[0];
    const id = attr(block, 'w:styleId');
    const nameM = block.match(/<w:name\s+w:val="([^"]*)"/);
    if (id) map.set(id, nameM ? decodeXml(nameM[1]) : id);
  }
  return map;
}

/** 一个 <w:p> 内部：文字片段 + 图片引用 + 样式/列表标记。 */
function readParagraphBody(body, rels, mediaByRel) {
  const styleM = body.match(/<w:pStyle\s+w:val="([^"]*)"/);
  const styleId = styleM ? decodeXml(styleM[1]) : '';
  const numPr = /<w:numPr>/.test(body);
  const tokens = [];
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>|<a:blip\b[^>]*?r:embed="([^"]+)"/g;
  let tm;
  while ((tm = re.exec(body))) {
    if (tm[1] !== undefined) {
      tokens.push({ kind: 'text', text: decodeXml(tm[1]) });
    } else if (tm[0].startsWith('<w:tab')) {
      tokens.push({ kind: 'text', text: '\t' });
    } else if (tm[0].startsWith('<w:br')) {
      tokens.push({ kind: 'text', text: '\n' });
    } else if (tm[2] !== undefined) {
      const rel = rels.get(tm[2]);
      const file = rel ? mediaByRel.get(rel.target) : null;
      if (file) tokens.push({ kind: 'image', file });
    }
  }
  const text = tokens.filter(t => t.kind === 'text').map(t => t.text).join('').trim();
  const images = tokens.filter(t => t.kind === 'image').map(t => t.file);
  return { text, images, styleId, listItem: numPr };
}

/**
 * 按文档顺序取出「段落」和「表格」。
 *
 * 之前用 /<w:p…>/ 全局扫，表格单元格里的每个 <w:p> 都会被当成正文段落，
 * 一张 3 行 4 列的获奖名单会被拆成 12 个短句、再被判成 12 个小节标题——
 * 成品里就出现一堆假小节。这里按标签顺序走一遍，表格整体收成一个 table 项。
 */
function parseDocumentItems(xml, rels, mediaByRel) {
  const items = [];
  let index = 0;
  let table = null;
  const re = /<w:tbl\b[^>]*>|<\/w:tbl\s*>|<w:tr\b[^>]*>|<\/w:tr\s*>|<w:tc\b[^>]*>|<\/w:tc\s*>|<w:p\b[^>]*>|<\/w:p\s*>/g;
  let m;
  const finishCell = () => {
    if (!table || table.cell === null) return;
    if (!table.row) table.row = [];
    table.row.push(table.cell.replace(/\s+/g, ' ').trim());
    table.cell = null;
  };
  const closeRow = () => {
    if (!table) return;
    finishCell();
    if (table.row && table.row.some(c => c)) table.rows.push(table.row);
    table.row = null;
  };
  while ((m = re.exec(xml))) {
    const tag = m[0];
    if (tag.startsWith('<w:tbl')) { table = { rows: [], row: null, cell: null }; continue; }
    if (tag.startsWith('</w:tbl')) {
      if (table) {
        closeRow();
        const rows = table.rows.filter(r => r.some(c => c));
        if (rows.length) items.push({ kind: 'table', index: index++, rows });
        table = null;
      }
      continue;
    }
    if (tag.startsWith('<w:tr')) { if (table) { closeRow(); table.row = []; } continue; }
    if (tag.startsWith('</w:tr')) { if (table) closeRow(); continue; }
    if (tag.startsWith('<w:tc')) { if (table) { finishCell(); table.cell = ''; } continue; }
    if (tag.startsWith('</w:tc')) { if (table) finishCell(); continue; }
    if (tag.startsWith('<w:p')) {
      const close = xml.indexOf('</w:p>', re.lastIndex);
      const body = close >= 0 ? xml.slice(re.lastIndex, close) : '';
      if (close >= 0) re.lastIndex = close + 6;
      const p = readParagraphBody(body, rels, mediaByRel);
      if (table) {
        if (table.cell === null) table.cell = '';
        if (p.text) table.cell += (table.cell ? ' ' : '') + p.text;
        continue;
      }
      if (!p.text && !p.images.length) continue;
      items.push({ kind: 'paragraph', index: index++, ...p });
      continue;
    }
  }
  return items;
}

const HEADING_RE = /(heading|标题|title)/i;

/** 署名行：文字撰稿/初审/终审/排版…（这类短行绝不能当小节标题） */
const SIGNATURE_RE = /^(文字撰稿|文字|撰稿|撰文|排版|编辑|责编|初审|复审|终审|审核|校对|核稿|供稿|供图|摄影|图片|来源|作者|记者|指导老师|指导教师|监制|主编)\s*[：:]/;
/** 声明/注释类尾注 */
const NOTE_RE = /^(转载|声明|版权|免责声明|注[：:]|备注[：:])/;
/** END 的各种写法：END / — END — / 全文完 / 完 */
const END_RE = /^[\s—\-–·•|｜*＊]*\s*(end|the\s*end|全文完|完)\s*[\s—\-–·•|｜*＊]*$/i;

function looksLikeHeading(text, styleName) {
  if (!text) return false;
  if (HEADING_RE.test(styleName)) return true;
  if (SIGNATURE_RE.test(text)) return false;
  if (END_RE.test(text)) return false;
  if (/^[0-9]{1,2}[、.\s]/.test(text) && text.length <= 30) return true;
  if (/^[（(]?[一二三四五六七八九十]{1,2}[）)、]/.test(text) && text.length <= 30) return true;
  // 小标题常写成「领导勉励，青春奋进」——中间可以有逗号，但不能有句末标点、冒号、引号
  if (text.length <= 26 && !/[。！？；：]/.test(text) && !/[，,]\s*$/.test(text) && !/["'“”‘’]/.test(text)) return true;
  return false;
}

/** 「短行」：可能是小标题，也可能只是名单/署名/表格残片。连着的短行不当标题。 */
function isShortLine(p) {
  if (!p.text || p.listItem) return false;
  if (SIGNATURE_RE.test(p.text) || NOTE_RE.test(p.text) || END_RE.test(p.text)) return false;
  return p.text.length <= 26 && !/[。！？；：]/.test(p.text) && !/[，,]\s*$/.test(p.text);
}

/**
 * 解析 docx：
 * - 保留全部正文段落（一字不删）
 * - 抽出全部图片，并按原文出现顺序插回 blocks
 * - 只做「分类与结构」，不改文字
 */
export function parseDocxBuffer(buf) {
  const zip = readZip(buf);
  const docXml = zip.has('word/document.xml') ? zip.read('word/document.xml').toString('utf8') : '';
  if (!docXml) throw new Error('docx 里没有 word/document.xml');
  const relsXml = zip.has('word/_rels/document.xml.rels') ? zip.read('word/_rels/document.xml.rels').toString('utf8') : '';
  const rels = parseRels(relsXml);
  const stylesXml = zip.has('word/styles.xml') ? zip.read('word/styles.xml').toString('utf8') : '';
  const styles = parseStyles(stylesXml);

  const mediaByRel = new Map();
  const media = new Map();
  let mediaCount = 0;
  for (const name of zip.names()) {
    if (!/^word\/media\//.test(name) || name.endsWith('/')) continue;
    const data = zip.read(name);
    if (!data || !data.length) continue;
    mediaCount++;
    media.set(name, data);
  }
  for (const [, rel] of rels) {
    if (!rel.target) continue;
    const clean = rel.target.replace(/^\/?word\//, '').replace(/^\.\//, '');
    const full = 'word/' + clean.replace(/^media\//, 'media/');
    if (media.has(full)) mediaByRel.set(rel.target, full);
  }

  const items = parseDocumentItems(docXml, rels, mediaByRel);
  const paragraphs = items.filter(it => it.kind === 'paragraph');

  // 文档属性里的标题只作为参考；正文第一段更可信
  let coreTitle = '';
  if (zip.has('docProps/core.xml')) {
    const core = zip.read('docProps/core.xml').toString('utf8');
    const m = core.match(/<dc:title>([\s\S]*?)<\/dc:title>/);
    if (m) coreTitle = decodeXml(m[1]).trim();
  }

  return { items, paragraphs, media, mediaCount, styles, coreTitle };
}

function splitTitle(raw) {
  const parts = raw.split(/[｜|]/);
  const title = (parts[0] || '').trim();
  const subtitle = (parts.slice(1).join('｜') || '').trim();
  return { title, subtitle };
}

const CLOSING_RE = /^(结语|尾声|后记|编后|编后记|结束语|全文完)$/;
const CN_DIGIT = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 廿: 20, 卅: 30 };

/**
 * 汉字序号转数字：一…九、十、十一…十九、二十…九十九。
 * 认不出返回 0（调用方据此保留原文，绝不删字）。
 */
function cnNumber(s) {
  const str = String(s || '').trim();
  if (!str) return 0;
  const at = str.indexOf('十');
  if (at < 0) return CN_DIGIT[str] || 0;
  if (at === 0) return 10 + (str.length > 1 ? (CN_DIGIT[str.slice(1)] || 0) : 0);
  const tens = CN_DIGIT[str.slice(0, at)] || 0;
  const ones = str.length > at + 1 ? (CN_DIGIT[str.slice(at + 1)] || 0) : 0;
  return tens ? tens * 10 + ones : 0;
}

/**
 * 不少通稿的小标题自己就带编号（「01 领导勉励，青春奋进」/「一、名单公布」）。
 * 这里把已有编号抽成 number、从正文里摘掉，否则面板上会变成「01 01 领导勉励」。
 * 只有紧跟分隔符（空格/、/./：/)/）的才算编号，避免把「三下乡社会实践」吃掉。
 */
function splitSectionNumber(raw) {
  const text = String(raw || '').trim();
  let m = text.match(/^(\d{1,2})[\s、.．:：)）\]]\s*/);
  if (m && Number(m[1]) > 0 && Number(m[1]) <= 99) {
    const rest = text.slice(m[0].length).trim();
    if (rest) return { number: String(Number(m[1])).padStart(2, '0'), text: rest };
  }
  m = text.match(/^([零〇一二三四五六七八九十廿卅]{1,4})\s*[、.．]\s*/);
  if (m) {
    const rest = text.slice(m[0].length).trim();
    const n = cnNumber(m[1]);
    // 认得出就摘掉编号；认不出（如「廿一、」）宁可连编号一起留着，也不许删原文字。
    if (rest && n > 0) return { number: String(n).padStart(2, '0'), text: rest };
    if (rest) return { number: '', text: text, prefixed: true };
  }
  return { number: '', text: text };
}

/**
 * 把段落序列转成可渲染的 blocks。
 * 结构分类只依赖「位置 / 长度 / 标点 / 样式 / 表格」，之后可在面板里手动改。
 */
export function buildDraft(parsed, opts = {}) {
  const assets = [];
  let assetSeq = 0;
  const assetByFile = new Map();
  for (const [file, data] of parsed.media) {
    assetSeq++;
    const id = 'img' + assetSeq;
    const ext = (file.split('.').pop() || 'png').toLowerCase();
    assets.push({ id, file, data, ext, caption: '' });
    assetByFile.set(file, id);
  }

  const items = Array.isArray(parsed.items)
    ? parsed.items
    : (parsed.paragraphs || []).map(p => ({ kind: 'paragraph', ...p }));

  const blocks = [];
  let seq = 0;
  const push = (b) => { seq++; blocks.push({ id: 'b' + seq, ...b }); };

  // 连着的短行（≥2 行）多半是名单/署名/地址，不该各自变成一个小节。
  const shortRun = new Set();
  let run = [];
  const flushRun = () => {
    if (run.length >= 2) for (const it of run) shortRun.add(it);
    run = [];
  };
  for (const it of items) {
    if (it.kind !== 'paragraph') { flushRun(); continue; }
    const styleName = parsed.styles.get(it.styleId) || it.styleId || '';
    if (isShortLine(it) && !HEADING_RE.test(styleName)) run.push(it);
    else flushRun();
  }
  flushRun();

  const textParas = items.filter(it => it.kind === 'paragraph' && it.text);
  const first = textParas[0];
  // 首段会被当标题用掉，它本身再短也不该连累下一段：整段从「短行连坐」里剔除。
  if (first) shortRun.delete(first);
  const titleRaw = (first && first.text) || parsed.coreTitle || '未命名图文';
  const { title, subtitle } = splitTitle(titleRaw);
  const usedFirst = first ? first : null;

  push({ type: 'kicker', text: opts.kicker || '' });
  push({ type: 'title', text: title });
  if (subtitle) push({ type: 'subtitle', text: subtitle });

  let sectionNo = 0;
  let sawLead = false;

  for (const it of items) {
    if (it === usedFirst) continue;
    if (it.kind === 'table') {
      const rows = it.rows.map(r => r.slice());
      if (rows.length) push({ type: 'table', rows, header: rows.length > 1 ? rows[0] : null });
      continue;
    }
    const p = it;
    const styleName = parsed.styles.get(p.styleId) || p.styleId || '';
    for (const imgFile of p.images) {
      const assetId = assetByFile.get(imgFile);
      if (!assetId) continue;
      push({ type: 'image', asset: assetId, text: '' });
    }
    if (!p.text) continue;
    if (END_RE.test(p.text)) {
      push({ type: 'end', text: 'END' });
      continue;
    }
    if (SIGNATURE_RE.test(p.text)) {
      const last = blocks[blocks.length - 1];
      if (last && last.type === 'signature') last.text += '\n' + p.text;
      else push({ type: 'signature', text: p.text });
      continue;
    }
    if (NOTE_RE.test(p.text)) {
      push({ type: 'note', text: p.text });
      continue;
    }
    if (!sawLead && !looksLikeHeading(p.text, styleName)) {
      push({ type: 'lead', text: p.text });
      sawLead = true;
      continue;
    }
    if (looksLikeHeading(p.text, styleName) && !shortRun.has(p)) {
      sectionNo++;
      const num = splitSectionNumber(p.text);
      // 「结语 / 后记」这类收尾小标题不该带序号，否则成品里会出现「05 结语」。
      const closing = CLOSING_RE.test(num.text.replace(/[。.!！\s]/g, ''));
      // 原文自带认不出的编号时不再自动补号，否则会变成「05 廿一、…」
      const autoNo = num.prefixed ? '' : String(sectionNo).padStart(2, '0');
      push({ type: 'section', text: num.text, number: closing ? '' : (num.number || autoNo) });
      continue;
    }
    if (p.listItem || (shortRun.has(p) && p.text.length <= 40)) {
      push({ type: 'list', text: p.text });
      continue;
    }
    push({ type: 'paragraph', text: p.text });
  }

  return { title, subtitle, blocks, assets };
}
