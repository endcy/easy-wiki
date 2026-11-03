#!/usr/bin/env node
'use strict';

/**
 * easy-wiki — 动态文件浏览与文档展示服务
 *
 * 零构建、每次请求实时读盘（目录树 / 文件内容都是最新的），
 * 支持多 wiki、多文件夹浏览，md / text / html 三种格式展示。
 *
 * 端点：
 *   GET  /                文件浏览页（SPA）
 *   GET  /api/tree?path=  目录树
 *   GET  /api/config      前端配置（标题、tab 模式、是否可编辑）
 *   GET  /view?path=      md / text 渲染查看页（?embed=1 隐藏导航；?theme=dark 深色）
 *   GET  /raw/<root>/...  原始文件 / 静态资源 / html
 *   POST /api/edit        编辑文档（JSON: { path, password, content }）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');

const tree = require('./lib/tree');
const renderer = require('./lib/renderer');
const { mimeFor } = require('./lib/mime');

const APP_DIR = __dirname;
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const CONFIG_PATH = path.join(APP_DIR, 'web.config');

// ─── 控制台颜色 ──────────────────────────────────────────────────
const isTTY = process.stdout.isTTY === true;
const C = {
  reset: isTTY ? '\x1b[0m' : '',
  dim: isTTY ? '\x1b[2m' : '',
  red: isTTY ? '\x1b[31m' : '',
  green: isTTY ? '\x1b[32m' : '',
  yellow: isTTY ? '\x1b[33m' : '',
  cyan: isTTY ? '\x1b[36m' : '',
};

function log(level, msg) {
  const color = { info: C.cyan, warn: C.yellow, error: C.red }[level] || '';
  const time = new Date().toISOString().slice(11, 19);
  console.log(`${C.dim}[${time}]${C.reset} ${color}[${level}]${C.reset} ${msg}`);
}

// ─── 配置加载（磁盘缓存，文件变更时热加载）────────────────────────
let cachedConfig = null;

function stripJsonComments(text) {
  let out = '';
  let inString = false, inLine = false, inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inLine) { if (c === '\n') { inLine = false; out += c; } continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
    if (inString) {
      out += c;
      if (c === '\\') { out += n || ''; i++; }
      else if (c === '"') { inString = false; }
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    out += c;
  }
  return out;
}

function defaults() {
  return {
    port: 82,
    bind: '0.0.0.0',
    title: 'Easy Wiki · 文档浏览',
    editPassword: '',
    tabMode: 'multi',
    maxTabs: 10,
    ignore: [
      'node_modules', '.git', '.vitepress', '.idea', '.omc', '.tmp', '.claude',
      'log', 'dist', 'target', '__pycache__', '*.iml',
    ],
    ignoreHidden: true,
    roots: [],
    autoRefreshSeconds: 0,
  };
}

function loadConfig() {
  if (cachedConfig) return cachedConfig;
  let fileCfg = {};
  try {
    fileCfg = JSON.parse(stripJsonComments(fs.readFileSync(CONFIG_PATH, 'utf-8')));
  } catch (err) {
    if (err.code === 'ENOENT') {
      log('warn', 'web.config 不存在，使用默认配置');
    } else {
      log('warn', `web.config 解析失败：${err.message}`);
    }
  }
  cachedConfig = Object.assign({}, defaults(), fileCfg);
  // 规范化 tabMode
  if (!['single', 'perType', 'multi'].includes(cachedConfig.tabMode)) {
    cachedConfig.tabMode = 'multi';
  }
  if (typeof cachedConfig.maxTabs !== 'number' || cachedConfig.maxTabs < 1) {
    cachedConfig.maxTabs = 10;
  }
  return cachedConfig;
}

// ─── CSS 缓存（doc 页样式 + 代码高亮主题 + 暗色主题）─────────────
let docCss = '';
let docDarkCss = '';
let hljsCss = '';
let hljsDarkCss = '';

function loadCss() {
  try { docCss = fs.readFileSync(path.join(PUBLIC_DIR, 'doc.css'), 'utf-8'); } catch (_) {}
  try { docDarkCss = fs.readFileSync(path.join(PUBLIC_DIR, 'doc-dark.css'), 'utf-8'); } catch (_) { docDarkCss = ''; }

  const candidates = [
    path.join(APP_DIR, 'node_modules', 'highlight.js', 'styles', 'github.css'),
    path.join(APP_DIR, 'node_modules', 'highlight.js', 'styles', 'github-dark.css'),
  ];
  for (const p of candidates) {
    try { hljsCss = fs.readFileSync(p, 'utf-8'); if (hljsCss) break; } catch (_) {}
  }
  const darkCandidates = [
    path.join(APP_DIR, 'node_modules', 'highlight.js', 'styles', 'github-dark.css'),
    path.join(APP_DIR, 'node_modules', 'highlight.js', 'styles', 'github.css'),
  ];
  for (const p of darkCandidates) {
    try { hljsDarkCss = fs.readFileSync(p, 'utf-8'); if (hljsDarkCss) break; } catch (_) {}
  }
}

// ─── 工具 ────────────────────────────────────────────────────────
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

function formatTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 文本解码：优先 UTF-8（去除 BOM），若出现替换符则回退 GBK
function decodeText(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.slice(3).toString('utf-8');
  }
  const utf8 = buf.toString('utf-8');
  if (!/�/.test(utf8)) return utf8;
  try { return new TextDecoder('gbk').decode(buf); } catch (_) { return utf8; }
}

// 可编辑的扩展名（与前端 TEXT_EXTS 对齐）
const EDITABLE_EXTS = new Set([
  'md', 'markdown', 'txt', 'text', 'json', 'yaml', 'yml', 'csv', 'log',
  'ini', 'conf', 'xml', 'properties', 'sh', 'bat', 'ps1', 'py', 'js',
  'ts', 'jsx', 'tsx', 'css', 'scss', 'less', 'sql', 'java', 'c', 'cpp',
  'h', 'hpp', 'go', 'rs', 'vue', 'html', 'htm',
]);

// ─── 响应辅助 ────────────────────────────────────────────────────
function sendText(res, code, text, mime) {
  const body = Buffer.from(String(text));
  res.writeHead(code, {
    'Content-Type': (mime || 'text/plain') + '; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

function sendHtml(res, html) {
  sendText(res, 200, html, 'text/html');
}

function sendJson(res, obj, code) {
  sendText(res, code || 200, JSON.stringify(obj), 'application/json');
}

function serveStatic(res, filePath, mime) {
  try {
    const buf = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': buf.length, 'Cache-Control': 'no-cache' });
    res.end(buf);
  } catch (_) {
    sendText(res, 404, 'Not Found');
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const MAX = 20 * 1024 * 1024; // 20MB
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX) { reject(new Error('Payload too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ─── 处理器 ──────────────────────────────────────────────────────
function handleConfig(res) {
  const config = loadConfig();
  sendJson(res, {
    title: config.title,
    autoRefreshSeconds: config.autoRefreshSeconds || 0,
    tabMode: config.tabMode,
    maxTabs: config.maxTabs,
    editEnabled: !!config.editPassword,
  });
}

function handleTree(url, res) {
  const config = loadConfig();
  const q = url.searchParams.get('path') || '';
  const nodes = q ? tree.listChildren(q, config) : tree.listRoots(config);
  sendJson(res, { path: q, nodes });
}

const TEXT_VIEW_EXTS = new Set([
  'txt', 'text', 'json', 'yaml', 'yml', 'csv', 'log', 'ini', 'conf', 'xml',
  'properties', 'sh', 'bat', 'ps1', 'py', 'js', 'ts', 'jsx', 'tsx', 'css',
  'scss', 'less', 'sql', 'java', 'c', 'cpp', 'h', 'hpp', 'go', 'rs', 'vue',
]);

function handleView(url, res) {
  const config = loadConfig();
  const roots = tree.normalizeRoots(config);
  const virtualPath = url.searchParams.get('path') || '';
  const embed = url.searchParams.get('embed') === '1';
  const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light';

  const rv = tree.resolveVirtual(virtualPath, roots);
  if (!rv) return sendText(res, 404, 'Not Found');

  let st;
  try { st = fs.statSync(rv.abs); } catch (_) { return sendText(res, 404, 'Not Found'); }
  if (st.isDirectory()) {
    res.writeHead(302, { Location: '/?path=' + encodeURIComponent(virtualPath) });
    return res.end();
  }

  const ext = path.extname(rv.abs).slice(1).toLowerCase();
  const rawUrl = '/raw/' + renderer.encodeVP(virtualPath);
  const rootName = rv.root.name;
  const dirVirtual = path.posix.dirname(virtualPath) === '.'
    ? rootName
    : path.posix.dirname(virtualPath);
  const mtimeLabel = formatTime(st.mtimeMs);
  const baseName = path.basename(rv.abs);
  const baseCss = docCss;
  const css = theme === 'dark' && docDarkCss ? (baseCss + '\n' + docDarkCss) : baseCss;
  const hljs = theme === 'dark' ? hljsDarkCss : hljsCss;

  if (ext === 'md' || ext === 'markdown') {
    const text = decodeText(fs.readFileSync(rv.abs));
    const { body, front } = renderer.stripFrontmatter(text);
    const bodyHtml = renderer.renderMarkdown(body, { rootName, dirVirtual });
    const tags = Array.isArray(front.tags)
      ? front.tags
      : (front.tags ? String(front.tags).split(/[,，]/) : []);
    const html = renderer.docPage({
      title: front.title || baseName.replace(/\.(md|markdown)$/i, ''),
      virtualPath,
      mtimeLabel,
      tags,
      bodyHtml,
      rawUrl,
      css,
      hljsCss: hljs,
      config,
      embed,
      theme,
    });
    return sendHtml(res, html);
  }

  if (TEXT_VIEW_EXTS.has(ext)) {
    const text = decodeText(fs.readFileSync(rv.abs));
    const bodyHtml = renderer.highlightText(text, ext);
    const html = renderer.docPage({
      title: baseName,
      virtualPath,
      mtimeLabel,
      tags: [],
      bodyHtml,
      rawUrl,
      css,
      hljsCss: hljs,
      config,
      embed,
      theme,
    });
    return sendHtml(res, html);
  }

  // 其它（图片 / html / pdf 等）→ 交给 /raw 原样返回
  res.writeHead(302, { Location: rawUrl });
  res.end();
}

function handleRaw(pathname, res) {
  const config = loadConfig();
  const roots = tree.normalizeRoots(config);
  let virtualPath;
  try { virtualPath = decodeURIComponent(pathname.slice('/raw/'.length)); }
  catch (_) { return sendText(res, 400, 'Bad Request'); }

  const rv = tree.resolveVirtual(virtualPath, roots);
  if (!rv) return sendText(res, 404, 'Not Found');

  let st;
  try { st = fs.statSync(rv.abs); } catch (_) { return sendText(res, 404, 'Not Found'); }
  if (st.isDirectory()) {
    res.writeHead(302, { Location: '/?path=' + encodeURIComponent(virtualPath) });
    return res.end();
  }

  const buf = fs.readFileSync(rv.abs);
  res.writeHead(200, {
    'Content-Type': mimeFor(rv.abs),
    'Content-Length': buf.length,
    'Cache-Control': 'no-cache',
  });
  res.end(buf);
}

async function handleEdit(req, res) {
  const config = loadConfig();
  if (!config.editPassword) {
    return sendJson(res, { ok: false, error: '编辑功能已禁用（web.config 未配置 editPassword）' }, 403);
  }
  let body;
  try { body = await readJsonBody(req); }
  catch (_) { return sendJson(res, { ok: false, error: '请求体解析失败' }, 400); }

  const { path: virtualPath, password, content } = body || {};
  if (!virtualPath || typeof password !== 'string' || typeof content !== 'string') {
    return sendJson(res, { ok: false, error: '参数不完整' }, 400);
  }
  if (password !== config.editPassword) {
    log('warn', `编辑密码错误：path=${virtualPath}`);
    return sendJson(res, { ok: false, error: '密码错误' }, 403);
  }

  const roots = tree.normalizeRoots(config);
  const rv = tree.resolveVirtual(virtualPath, roots);
  if (!rv) return sendJson(res, { ok: false, error: '路径无效' }, 404);

  let st;
  try { st = fs.statSync(rv.abs); } catch (_) { return sendJson(res, { ok: false, error: '文件不存在' }, 404); }
  if (!st.isFile()) return sendJson(res, { ok: false, error: '不是文件' }, 400);

  const ext = path.extname(rv.abs).slice(1).toLowerCase();
  if (!EDITABLE_EXTS.has(ext)) {
    return sendJson(res, { ok: false, error: `不支持编辑该类型文件 (.${ext})` }, 400);
  }

  try {
    fs.writeFileSync(rv.abs, content, 'utf-8');
    log('info', `已保存：${virtualPath} (${content.length} 字符)`);
    return sendJson(res, { ok: true });
  } catch (err) {
    log('error', `保存失败：${err.message}`);
    return sendJson(res, { ok: false, error: '保存失败：' + err.message }, 500);
  }
}

// ─── 新建目录 ────────────────────────────────────────────────────
async function handleMkdir(req, res) {
  const config = loadConfig();
  if (!config.editPassword) {
    return sendJson(res, { ok: false, error: '操作需要密码（web.config 未配置 editPassword）' }, 403);
  }
  let body;
  try { body = await readJsonBody(req); }
  catch (_) { return sendJson(res, { ok: false, error: '请求体解析失败' }, 400); }

  const { path: virtualPath, password, name } = body || {};
  if (!virtualPath || typeof password !== 'string' || typeof name !== 'string' || !name.trim()) {
    return sendJson(res, { ok: false, error: '参数不完整' }, 400);
  }
  if (password !== config.editPassword) {
    log('warn', `mkdir 密码错误：path=${virtualPath}`);
    return sendJson(res, { ok: false, error: '密码错误' }, 403);
  }
  // 不允许名字包含路径分隔符
  if (/[\/\\]/.test(name)) {
    return sendJson(res, { ok: false, error: '目录名不能包含 / 或 \\' }, 400);
  }

  const roots = tree.normalizeRoots(config);
  const rv = tree.resolveVirtual(virtualPath, roots);
  if (!rv) return sendJson(res, { ok: false, error: '路径无效' }, 404);

  let st;
  try { st = fs.statSync(rv.abs); } catch (_) { return sendJson(res, { ok: false, error: '父目录不存在' }, 404); }
  if (!st.isDirectory()) return sendJson(res, { ok: false, error: '父路径不是目录' }, 400);

  const newDir = path.join(rv.abs, name.trim());
  // 路径穿越保护
  const prefix = rv.abs.endsWith(path.sep) ? rv.abs : rv.abs + path.sep;
  if (!newDir.startsWith(prefix)) {
    return sendJson(res, { ok: false, error: '路径无效' }, 400);
  }

  try {
    fs.mkdirSync(newDir);
    log('info', `已创建目录：${virtualPath}/${name.trim()}`);
    return sendJson(res, { ok: true });
  } catch (err) {
    log('error', `创建目录失败：${err.message}`);
    return sendJson(res, { ok: false, error: '创建失败：' + err.message }, 500);
  }
}

// ─── 上传文件 ────────────────────────────────────────────────────
async function handleUpload(req, res) {
  const config = loadConfig();
  if (!config.editPassword) {
    return sendJson(res, { ok: false, error: '操作需要密码（web.config 未配置 editPassword）' }, 403);
  }
  let body;
  try { body = await readJsonBody(req); }
  catch (_) { return sendJson(res, { ok: false, error: '请求体解析失败' }, 400); }

  const { path: virtualPath, password, name, content } = body || {};
  if (!virtualPath || typeof password !== 'string' || typeof name !== 'string' || !name.trim() || typeof content !== 'string') {
    return sendJson(res, { ok: false, error: '参数不完整' }, 400);
  }
  if (password !== config.editPassword) {
    log('warn', `upload 密码错误：path=${virtualPath}`);
    return sendJson(res, { ok: false, error: '密码错误' }, 403);
  }
  if (/[\/\\]/.test(name)) {
    return sendJson(res, { ok: false, error: '文件名不能包含 / 或 \\' }, 400);
  }

  const roots = tree.normalizeRoots(config);
  const rv = tree.resolveVirtual(virtualPath, roots);
  if (!rv) return sendJson(res, { ok: false, error: '路径无效' }, 404);

  let st;
  try { st = fs.statSync(rv.abs); } catch (_) { return sendJson(res, { ok: false, error: '目标目录不存在' }, 404); }
  if (!st.isDirectory()) return sendJson(res, { ok: false, error: '目标路径不是目录' }, 400);

  const targetFile = path.join(rv.abs, name.trim());
  const prefix = rv.abs.endsWith(path.sep) ? rv.abs : rv.abs + path.sep;
  if (!targetFile.startsWith(prefix)) {
    return sendJson(res, { ok: false, error: '路径无效' }, 400);
  }

  let buf;
  try {
    buf = Buffer.from(content, 'base64');
  } catch (_) {
    return sendJson(res, { ok: false, error: '文件内容解码失败' }, 400);
  }

  try {
    fs.writeFileSync(targetFile, buf);
    log('info', `已上传：${virtualPath}/${name.trim()} (${buf.length} 字节)`);
    return sendJson(res, { ok: true, size: buf.length });
  } catch (err) {
    log('error', `上传失败：${err.message}`);
    return sendJson(res, { ok: false, error: '上传失败：' + err.message }, 500);
  }
}

// ─── 服务 ────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const handler = async () => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
      return sendText(res, 405, 'Method Not Allowed');
    }
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (req.method === 'POST') {
      if (p === '/api/edit') return await handleEdit(req, res);
      if (p === '/api/mkdir') return await handleMkdir(req, res);
      if (p === '/api/upload') return await handleUpload(req, res);
      return sendText(res, 405, 'Method Not Allowed');
    }

    if (p === '/' || p === '/index.html') return serveStatic(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html; charset=utf-8');
    if (p === '/app.js') return serveStatic(res, path.join(PUBLIC_DIR, 'app.js'), 'application/javascript; charset=utf-8');
    if (p === '/style.css') return serveStatic(res, path.join(PUBLIC_DIR, 'style.css'), 'text/css; charset=utf-8');
    if (p === '/api/tree') return handleTree(url, res);
    if (p === '/api/config') return handleConfig(res);
    if (p === '/view') return handleView(url, res);
    if (p.startsWith('/raw/')) return handleRaw(p, res);

    return sendText(res, 404, 'Not Found');
  };

  handler().catch((err) => {
    log('error', err.stack || String(err));
    if (!res.headersSent) sendText(res, 500, 'Internal Server Error');
    else res.end();
  });
});

function start() {
  loadCss();
  const config = loadConfig();
  server.listen(config.port, config.bind, () => {
    const host = config.bind === '0.0.0.0' ? getLocalIP() : config.bind;
    log('info', `Easy Wiki 已启动：http://${host}:${config.port}`);
    log('info', `根目录：${(config.roots || []).map((r) => `${r.name} -> ${r.path}`).join('；') || '(未配置)'}`);
    log('info', `Tab 模式：${config.tabMode}（最多 ${config.maxTabs} 个）`);
    log('info', `编辑功能：${config.editPassword ? '已启用' : '已禁用'}`);
    log('info', '提示：内容每次打开都是磁盘最新数据，无需重新打包/重启。');
  });
}

// 监听 web.config 变更，热加载
fs.watchFile(CONFIG_PATH, { interval: 1000 }, () => {
  cachedConfig = null;
  log('info', 'web.config 已变更，配置已重新加载');
});

start();
