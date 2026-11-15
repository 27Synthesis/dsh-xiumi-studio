/**
 * 桌面壳的配置：端口与工作目录。
 *
 * 桌面端和右栏面板是同一套 client，工程落在「工作目录/.xiumi/」里，
 * 所以在桌面里建好的稿子，在 DSH 面板里指向同一个目录就能接着改。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_PORT = 50577; // 固定端口：秀米 OAuth 的 redirectUri 带端口，换了就要重新注册客户端
export const DESKTOP_SESSION = 'desktop';

export function configPath(homeDir) {
  return path.join(homeDir, 'desktop.json');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 默认工作目录：文档/秀米工作台；没有「文档」就退回用户目录。 */
export function defaultWorkspace() {
  const home = os.homedir();
  const docs = path.join(home, 'Documents');
  return fs.existsSync(docs) ? path.join(docs, '秀米工作台') : path.join(home, '秀米工作台');
}

export function loadConfig(homeDir) {
  const file = configPath(homeDir);
  const raw = readJson(file, {}) || {};
  const port = Number(raw.port) || DEFAULT_PORT;
  const workspace = typeof raw.workspace === 'string' && raw.workspace.trim() ? raw.workspace.trim() : defaultWorkspace();
  return {
    file,
    port: Math.min(65535, Math.max(1024, Math.floor(port))),
    workspace,
  };
}

export function saveConfig(homeDir, cfg) {
  const file = configPath(homeDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ port: cfg.port, workspace: cfg.workspace }, null, 2), 'utf8');
  return file;
}
