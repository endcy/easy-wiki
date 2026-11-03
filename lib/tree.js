'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 目录树相关逻辑：
 *  - normalizeRoots：把 config.roots 规整为 [{ name, path }]（绝对路径）
 *  - 虚拟路径（virtual path）= `<rootName>/<相对路径>`，是前端与后端之间的统一寻址方式。
 */

function normalizeRoots(config) {
  const roots = [];
  const seen = new Set();
  for (const r of (config && config.roots) || []) {
    if (!r || !r.name || !r.path) continue;
    if (seen.has(r.name)) continue;
    seen.add(r.name);
    roots.push({ name: r.name, path: path.resolve(String(r.path)) });
  }
  return roots;
}

function isIgnored(name, config) {
  if (!config) return false;
  if (config.ignoreHidden && String(name).startsWith('.')) return true;
  const n = String(name).toLowerCase();
  for (const it of config.ignore || []) {
    if (typeof it !== 'string' || !it) continue;
    const e = it.toLowerCase();
    if (e.startsWith('*.')) {
      if (n.endsWith(e.slice(1))) return true; // *.ext
    } else if (n === e) {
      return true;
    }
  }
  return false;
}

// 把虚拟路径拆成 { name, rest }
function splitVirtual(virtualPath) {
  const s = String(virtualPath || '').replace(/^\/+|\/+$/g, '');
  if (!s) return { name: null, rest: '' };
  const idx = s.indexOf('/');
  if (idx === -1) return { name: s, rest: '' };
  return { name: s.slice(0, idx), rest: s.slice(idx + 1) };
}

function findRoot(virtualPath, roots) {
  const { name, rest } = splitVirtual(virtualPath);
  const root = roots.find((r) => r.name === name);
  return root ? { root, rest } : null;
}

// 虚拟路径 → 绝对路径（带路径穿越保护）
function resolveVirtual(virtualPath, roots) {
  const fr = findRoot(virtualPath, roots);
  if (!fr) return null;
  const abs = path.resolve(fr.root.path, fr.rest || '');
  const prefix = fr.root.path.endsWith(path.sep) ? fr.root.path : fr.root.path + path.sep;
  if (abs !== fr.root.path && !abs.startsWith(prefix)) return null;
  return { root: fr.root, rest: fr.rest || '', abs };
}

function hasChildren(abs, config) {
  try {
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    for (const e of entries) {
      if (isIgnored(e.name, config)) continue;
      return true;
    }
  } catch (_) {
    /* ignore */
  }
  return false;
}

function listRoots(config) {
  const roots = normalizeRoots(config);
  return roots.map((r) => ({
    name: r.name,
    path: r.name,
    type: 'dir',
    hasChildren: hasChildren(r.path, config),
  }));
}

function listChildren(virtualPath, config) {
  const roots = normalizeRoots(config);
  const fr = findRoot(virtualPath, roots);
  if (!fr) return [];
  const abs = path.resolve(fr.root.path, fr.rest || '');

  let entries = [];
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch (_) {
    return [];
  }

  const nodes = [];
  for (const e of entries) {
    if (isIgnored(e.name, config)) continue;
    const childAbs = path.join(abs, e.name);
    const childVirtual = (fr.rest ? fr.rest + '/' : '') + e.name;
    let node;
    if (e.isDirectory()) {
      node = {
        name: e.name,
        path: fr.root.name + '/' + childVirtual,
        type: 'dir',
        hasChildren: hasChildren(childAbs, config),
      };
    } else if (e.isFile()) {
      node = {
        name: e.name,
        path: fr.root.name + '/' + childVirtual,
        type: 'file',
        ext: path.extname(e.name).slice(1).toLowerCase(),
      };
      try {
        const st = fs.statSync(childAbs);
        node.size = st.size;
        node.mtime = st.mtimeMs;
      } catch (_) {
        /* ignore */
      }
    } else {
      continue; // 跳过符号链接等其它类型
    }
    nodes.push(node);
  }

  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
  });

  return nodes;
}

module.exports = {
  normalizeRoots,
  isIgnored,
  findRoot,
  resolveVirtual,
  listRoots,
  listChildren,
};
