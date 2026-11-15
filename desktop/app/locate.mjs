/**
 * 桌面壳和插件共用的那一份 host/ 与 client/ 在哪儿。
 *
 * 两种布局，不复制业务代码（PLAN-R2 AD-4）：
 *   开发：仓库根/desktop/app/*.mjs          → 根 = 仓库根
 *   打包：resources/app/shell/*.mjs         → 根 = resources/app（host/ client/ 并排在旁边）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SHELL_DIR = path.dirname(fileURLToPath(import.meta.url));

let cachedRoot = null;

export function locateRoots() {
  if (cachedRoot) return { root: cachedRoot, shell: SHELL_DIR };
  const candidates = [
    path.resolve(SHELL_DIR, '..', '..'), // 仓库布局：desktop/app → 仓库根
    path.resolve(SHELL_DIR, '..'), // 打包布局：resources/app/shell → resources/app
  ];
  for (const dir of candidates) {
    const okHost = fs.existsSync(path.join(dir, 'host', 'routes.mjs'));
    const okClient = fs.existsSync(path.join(dir, 'client', 'studio.html'));
    if (okHost && okClient) {
      cachedRoot = dir;
      return { root: dir, shell: SHELL_DIR };
    }
  }
  throw new Error('桌面壳找不到 host/ 与 client/（找过：' + candidates.join('、') + '）');
}

/** 按名字加载插件的 host 模块；路径是运行时才知道的，所以必须动态 import。 */
export async function loadHost(name) {
  const { root } = locateRoots();
  return import(pathToFileURL(path.join(root, 'host', name)).href);
}
