/**
 * 导入 Word（桌面壳自己的入口）。
 *
 * 上游把「解析 → 建工程 → 落素材 → 画封面」放在模型工具里（host/tools.mjs 的 importDocx），
 * 没有 http 路由，所以桌面这边按同一条管线走一遍 host 模块——不复制解析逻辑，只做管线装配。
 * 建议上游补 /xiumi/api/import 之后这里退化成一次转发。
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadHost } from './locate.mjs';

export async function importDocxFile({ workspace, file, sessionId = 'desktop', kicker = '', theme = '', log = () => {} }) {
  const store = await loadHost('store.mjs');
  const docx = await loadHost('docx.mjs');
  const themes = await loadHost('themes.mjs');
  const { makeCover } = await loadHost('cover.mjs');

  const abs = path.isAbsolute(file) ? file : path.resolve(workspace, file);
  if (!fs.existsSync(abs)) throw new Error('找不到这个文件：' + abs);
  if (path.extname(abs).toLowerCase() !== '.docx') throw new Error('只吃 .docx（.doc 请先另存为 .docx）');

  const cwd = store.canonicalCwd(workspace);
  store.ensureLayout(cwd);

  const buf = fs.readFileSync(abs);
  const parsed = docx.parseDocxBuffer(buf);
  const draft = docx.buildDraft(parsed, { kicker });
  if (!draft.blocks.length) throw new Error('这个 Word 里没读到正文（可能是扫描件或纯图片）');

  const picked = theme && themes.THEMES.some((t) => t.id === theme) ? theme : themes.pickThemeFor(draft.title + ' ' + (draft.subtitle || ''));

  // 素材名沿用 docx 里的 media 名，重名加序号——和上游导入保持一致
  const nameById = new Map();
  const assets = [];
  const used = new Set();
  for (const a of draft.assets) {
    let name = path.basename(a.file);
    let n = 1;
    while (used.has(name)) {
      const dot = name.lastIndexOf('.');
      name = (dot > 0 ? name.slice(0, dot) : name) + '-' + n++ + a.ext;
    }
    used.add(name);
    nameById.set(a.id, name);
    assets.push({ id: a.id, name, bytes: a.data.length, kind: 'image' });
  }
  const blocks = draft.blocks.map((b) => (b.type === 'image' ? { ...b, asset: nameById.get(b.asset) || b.asset } : b));
  if (!blocks.some((b) => b.type === 'end')) blocks.push({ id: 'b' + (blocks.length + 1), type: 'end', text: 'END' });

  const project = store.createProject(cwd, {
    title: draft.title,
    subtitle: draft.subtitle,
    kicker,
    date: '',
    theme: picked,
    blocks,
    assets,
    source: { file: abs, media: parsed.media.size, paragraphs: parsed.paragraphs.filter((p) => p.text).length },
  });
  for (const a of draft.assets) store.saveAsset(cwd, project.id, nameById.get(a.id), a.data, 'image');
  store.setActive(cwd, sessionId, project.id);
  store.addEvent(cwd, project.id, 'import', '桌面端从 Word 拆出 ' + assets.length + ' 张图 · ' + blocks.length + ' 个块');

  // 封面顺手画好；画不出来（缺 Python / 字体）不阻断导入，把原因带回去
  let coverError = null;
  try {
    await makeCover({ project, dir: store.projectDir(cwd, project.id), log });
    store.updateProject(cwd, project.id, (p) => {
      p.cover = { cover: 'cover.png', square: 'square.png', at: new Date().toISOString() };
      return p;
    });
    store.addEvent(cwd, project.id, 'cover', '按「' + themes.getTheme(picked).name + '」生成封面');
  } catch (error) {
    coverError = (error && error.message) || String(error);
    log('[xiumi] 封面生成失败：' + coverError);
  }

  const saved = store.readProject(cwd, project.id);
  return {
    projectId: project.id,
    title: saved.title,
    theme: saved.theme,
    blocks: (saved.blocks || []).length,
    images: assets.length,
    cover: !!(saved.cover && saved.cover.cover),
    coverError,
  };
}
