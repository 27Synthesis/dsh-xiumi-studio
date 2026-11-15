/**
 * 项目仓库：一篇图文 = 工作目录里 .xiumi/projects/<id>/ 一个目录。
 *
 *   project.json   排版工程（blocks 是有序块，图与文字的顺序就是正文顺序）
 *   assets/        从 docx 解出来的原图，文件名保留原名
 *   cover.png      公众号封面 900x383
 *   square.png     分享方图 500x500
 *   index.json     本工作目录下所有工程的索引（面板「最近」列表用）
 *
 * 为什么一个工程一个目录：素材与工程同生共死，删工程不会留下孤儿图；
 * 换工作目录也只是换根，不依赖任何全局状态。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const ROOT_DIR = '.xiumi';

export function canonicalCwd(cwd) {
  try {
    return fs.realpathSync.native(cwd);
  } catch {
    return cwd;
  }
}

export function rootOf(cwd) {
  return path.join(cwd, ROOT_DIR);
}

export function ensureLayout(cwd) {
  const root = rootOf(cwd);
  fs.mkdirSync(path.join(root, 'projects'), { recursive: true });
  return root;
}

export function projectDir(cwd, id) {
  if (!/^p_[A-Za-z0-9_-]+$/.test(String(id || ''))) throw new Error('工程 id 不合法：' + id);
  return path.join(rootOf(cwd), 'projects', id);
}

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + pad(d.getHours()) + pad(d.getMinutes());
  return 'p_' + stamp + '_' + crypto.randomBytes(3).toString('hex');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function readIndex(cwd) {
  return readJson(path.join(rootOf(cwd), 'projects', 'index.json'), { projects: [] });
}

function writeIndex(cwd, index) {
  writeJson(path.join(rootOf(cwd), 'projects', 'index.json'), index);
}

function touchIndex(cwd, project) {
  const index = readIndex(cwd);
  const row = {
    id: project.id,
    title: project.title || '未命名图文',
    theme: project.theme,
    status: project.status || 'draft',
    images: (project.blocks || []).filter((b) => b.type === 'image').length,
    updatedAt: project.updatedAt,
    xiumi: project.xiumi || null,
  };
  const rest = index.projects.filter((p) => p.id !== project.id);
  index.projects = [row].concat(rest).slice(0, 60);
  writeIndex(cwd, index);
}

export function listProjects(cwd) {
  const index = readIndex(cwd);
  const rows = Array.isArray(index.projects) ? index.projects : [];
  // 索引是缓存，目录才是事实：工程被人手动删掉（或清理脚本删掉）后，
  // 列表里不该留一条点开就 404 的幽灵。顺手把索引修回真实状态。
  const alive = rows.filter((row) => row && row.id
    && fs.existsSync(path.join(projectDir(cwd, row.id), 'project.json')));
  if (alive.length !== rows.length) {
    try { writeIndex(cwd, Object.assign({}, index, { projects: alive })); } catch (err) { /* 索引写不进去也不该拖垮列表 */ }
  }
  return alive;
}

export function createProject(cwd, draft) {
  ensureLayout(cwd);
  const id = newId();
  const dir = projectDir(cwd, id);
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  const project = {
    id,
    title: draft.title || '未命名图文',
    subtitle: draft.subtitle || '',
    kicker: draft.kicker || '',
    date: draft.date || '',
    theme: draft.theme || 'zhusha',
    status: 'draft',
    source: draft.source || null,
    blocks: draft.blocks || [],
    assets: draft.assets || [],
    cover: draft.cover || null,
    events: [],
    xiumi: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  writeProject(cwd, project);
  addEvent(cwd, id, 'created', '建立排版工程：' + project.title);
  return project;
}

export function writeProject(cwd, project) {
  project.updatedAt = nowIso();
  writeJson(path.join(projectDir(cwd, project.id), 'project.json'), project);
  touchIndex(cwd, project);
  return project;
}

export function readProject(cwd, id) {
  const file = path.join(projectDir(cwd, id), 'project.json');
  const project = readJson(file, null);
  if (!project) return null;
  project.assets = (project.assets || []).map((a) => ({ ...a, url: '/xiumi/api/asset/' + project.id + '/' + encodeURIComponent(a.name) }));
  return project;
}

export function updateProject(cwd, id, mutate) {
  const project = readProject(cwd, id);
  if (!project) throw new Error('没有这个工程：' + id);
  const next = mutate(project) || project;
  // readProject 给资产补了 url，写回时去掉，避免把派生字段固化进磁盘
  next.assets = (next.assets || []).map((a) => ({ id: a.id, name: a.name, bytes: a.bytes, kind: a.kind, width: a.width, height: a.height }));
  return writeProject(cwd, next);
}

export function addEvent(cwd, id, kind, text) {
  const project = readProject(cwd, id);
  if (!project) return null;
  const events = (project.events || []).concat([{ at: nowIso(), kind, text }]);
  project.events = events.slice(-120);
  project.assets = (project.assets || []).map((a) => ({ id: a.id, name: a.name, bytes: a.bytes, kind: a.kind, width: a.width, height: a.height }));
  writeProject(cwd, project);
  return project;
}

/**
 * 另存一版：素材、封面、块全部复制到新工程，发布状态清空。
 * 用途是多版本比较——改版式前先存一版，改坏了能回来看。
 */
export function duplicateProject(cwd, id, opts = {}) {
  const src = readProject(cwd, id);
  if (!src) throw new Error('没有这个工程：' + id);
  ensureLayout(cwd);
  const newPid = newId();
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = newPid;
  copy.title = opts.title || (src.title + '（副本）');
  copy.status = 'draft';
  copy.xiumi = null;
  copy.publishedAt = null;
  copy.createdAt = nowIso();
  copy.updatedAt = nowIso();
  copy.events = [];
  copy.assets = (copy.assets || []).map((a) => ({ id: a.id, name: a.name, bytes: a.bytes, kind: a.kind, width: a.width, height: a.height }));
  fs.mkdirSync(path.join(projectDir(cwd, newPid), 'assets'), { recursive: true });
  for (const a of copy.assets) {
    try { fs.copyFileSync(assetPath(cwd, id, a.name), assetPath(cwd, newPid, a.name)); } catch (err) { /* 缺素材不该挡住复制 */ }
  }
  for (const which of ['cover', 'square']) {
    try { fs.copyFileSync(coverPath(cwd, id, which), coverPath(cwd, newPid, which)); } catch (err) { /* 没封面也正常 */ }
  }
  writeProject(cwd, copy);
  addEvent(cwd, newPid, 'created', '从「' + src.title + '」另存一版');
  return readProject(cwd, newPid);
}

/** 去掉一张素材，连带删掉引用它的图片块（用户误拖进来时要能撤回）。 */
export function removeAsset(cwd, id, name) {
  const safe = path.basename(String(name || ''));
  if (!safe) throw new Error('素材名不合法');
  const before = readProject(cwd, id);
  if (!before) throw new Error('没有这个工程：' + id);
  if (!(before.assets || []).some((a) => a.name === safe)) throw new Error('没有这张素材：' + safe);
  let removedBlocks = 0;
  updateProject(cwd, id, (p) => {
    const keep = (p.blocks || []).filter((b) => !(b.type === 'image' && b.asset === safe));
    removedBlocks = (p.blocks || []).length - keep.length;
    p.blocks = keep;
    p.assets = (p.assets || []).filter((a) => a.name !== safe);
    return p;
  });
  try { fs.rmSync(assetPath(cwd, id, safe), { force: true }); } catch (err) { /* 文件删不掉也不该炸 */ }
  addEvent(cwd, id, 'images', '去掉素材 ' + safe + (removedBlocks ? '（连带 ' + removedBlocks + ' 个图片块）' : ''));
  return { project: readProject(cwd, id), removedBlocks };
}

export function assetPath(cwd, id, name) {
  const dir = path.join(projectDir(cwd, id), 'assets');
  const safe = path.basename(String(name || ''));
  if (!safe || safe.startsWith('.')) throw new Error('素材名不合法');
  return path.join(dir, safe);
}

export function saveAsset(cwd, id, name, buffer, kind) {
  const abs = assetPath(cwd, id, name);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buffer);
  return { name: path.basename(abs), bytes: buffer.length, kind: kind || 'image' };
}

export function coverPath(cwd, id, which) {
  return path.join(projectDir(cwd, id), which === 'square' ? 'square.png' : 'cover.png');
}

export function activeProjectPath(cwd) {
  return path.join(rootOf(cwd), 'active.json');
}

export function readActive(cwd) {
  return readJson(activeProjectPath(cwd), {});
}

export function setActive(cwd, sessionId, projectId) {
  const map = readActive(cwd);
  map[sessionId || 'default'] = projectId;
  ensureLayout(cwd);
  writeJson(activeProjectPath(cwd), map);
}

export function activeProjectId(cwd, sessionId) {
  const map = readActive(cwd);
  return map[sessionId || 'default'] || (listProjects(cwd)[0] || {}).id || null;
}
