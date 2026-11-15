/**
 * 「让面板自己跳出来」。
 *
 * 工具调用发生在宿主进程里，它没法直接命令浏览器切标签页。所以这里只做一件事：
 * 记下「某个工作目录想被看见」这条请求，前端下一次轮询 /xiumi/api/state 时看到它，
 * 调官方 sidebarRight.openTab 把面板打开，再回来 ack 清掉。
 *
 * 键用 cwd 而不是 sessionId：同一个工作目录里可能有多个会话看同一篇稿子。
 * 但工具拿到的 cwd 和路由算出来的 cwd 斜杠方向不一定一样（Windows），
 * 所以统一归一化后再当键——否则"写进去的"和"读出来的"永远对不上。
 */
const pending = new Map();

function norm(cwd) {
  const s = String(cwd || '').split('\\').join('/');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

export function requestOpen(cwd, reason) {
  const key = norm(cwd);
  if (!key) return;
  pending.set(key, { at: Date.now(), reason: String(reason || 'open') });
}

export function readOpen(cwd) {
  const key = norm(cwd);
  if (!key) return null;
  return pending.get(key) || null;
}

export function clearOpen(cwd, at) {
  const key = norm(cwd);
  if (!key) return false;
  const cur = pending.get(key);
  if (!cur) return false;
  if (at && cur.at !== Number(at)) return false;
  pending.delete(key);
  return true;
}
