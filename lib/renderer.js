'use strict';

const path = require('path');
const MarkdownIt = require('markdown-it');
const hljs = require('highlight.js');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

/**
 * 剥离 YAML frontmatter（--- ... ---）。
 * 返回 { body, front }，front 为解析出的 key/value 对象。
 * 只有「块内包含 key: value 行」时才视为 frontmatter，避免误吞水平分割线。
 */
function stripFrontmatter(text) {
  const t = String(text).replace(/^﻿/, '');
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(t);
  if (m && /^[ \t]*[A-Za-z0-9_.-]+[ \t]*:[ \t]*\S/m.test(m[1])) {
    const front = {};
    for (const line of m[1].split(/\r?\n/)) {
      const mm = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
      if (!mm) continue;
      let v = mm[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      } else if (v.startsWith('[') && v.endsWith(']')) {
        try { v = JSON.parse(v); } catch (_) { /* 保持字符串 */ }
      } else if (v === 'true' || v === 'false') {
        v = v === 'true';
      }
      front[mm[1]] = v;
    }
    return { body: t.slice(m[0].length), front };
  }
  return { body: t, front: {} };
}

// 虚拟路径 → URL 安全的路径（逐段 encodeURIComponent）
function encodeVP(virtual) {
  return String(virtual).split('/').map(encodeURIComponent).join('/');
}

// 文本类扩展名 → 走 /view 渲染（与 server.js 中 TEXT_VIEW_EXTS 对齐）
const TEXT_VIEW_EXTS = new Set([
  'txt', 'text', 'json', 'yaml', 'yml', 'csv', 'log', 'ini', 'conf', 'xml',
  'properties', 'sh', 'bat', 'ps1', 'py', 'js', 'ts', 'jsx', 'tsx', 'css',
  'scss', 'less', 'sql', 'java', 'c', 'cpp', 'h', 'hpp', 'go', 'rs', 'vue',
]);

// 扩展名 → highlight.js 语言名映射（用于 text-view 语法高亮）
const LANG_MAP = {
  json: 'json', yaml: 'yaml', yml: 'yaml',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  py: 'python', sh: 'bash', bat: 'dos', ps1: 'powershell',
  java: 'java', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
  go: 'go', rs: 'rust',
  css: 'css', scss: 'scss', less: 'less',
  sql: 'sql', xml: 'xml', html: 'xml', htm: 'xml', svg: 'xml',
  ini: 'ini', conf: 'ini', properties: 'ini', toml: 'ini',
  vue: 'xml', md: 'markdown', markdown: 'markdown',
};

/**
 * 渲染文本类文件：带语法高亮（text-view 暗底专用）。
 * 若语言不支持或高亮失败，回退到纯文本。
 */
function highlightText(text, ext) {
  const lang = LANG_MAP[ext];
  if (lang && hljs.getLanguage(lang)) {
    try {
      const highlighted = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
      return '<pre class="text-view hljs"><code>' + highlighted + '</code></pre>';
    } catch (_) { /* fallthrough to plain */ }
  }
  return '<pre class="text-view">' + escapeHtml(text) + '</pre>';
}

/**
 * 解析 md 中的相对引用（图片 / 链接）。
 * 返回解析后的虚拟路径；若是外部 URL / 锚点等则返回 null 表示不处理。
 */
function resolveRef(dirVirtual, ref, rootName) {
  if (!ref) return null;
  if (/^(?:https?:|mailto:|data:|tel:|javascript:)/i.test(ref)) return null;
  // 去除锚点/查询
  const raw = ref.split('#')[0].split('?')[0];
  if (!raw) return null;
  // markdown-it 在解析链接时已对 href 做过一次 encodeURIComponent，
  // 这里必须先解码回原路径，后续 encodeVP 再统一编码一次，避免双重编码。
  let clean;
  try { clean = decodeURIComponent(raw); } catch (_) { clean = raw; }
  let out;
  if (clean.startsWith('/')) {
    out = rootName + clean; // 绝对路径 → 相对根
  } else {
    out = path.posix.normalize(path.posix.join(dirVirtual || rootName, clean));
  }
  return out.replace(/^\/+/, '');
}

function createMd() {
  return new MarkdownIt({
    html: true,
    linkify: true,
    breaks: false,
    typographer: true,
    highlight(str, lang) {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return '<pre class="hljs"><code>' +
            hljs.highlight(str, { language: lang, ignoreIllegals: true }).value +
            '</code></pre>';
        } catch (_) { /* fallthrough */ }
      }
      return '<pre class="hljs"><code>' + escapeHtml(str) + '</code></pre>';
    },
  });
}

/**
 * 渲染 markdown → HTML。
 *  - 相对图片 → /raw/<虚拟路径>
 *  - 相对 .md 链接 → /view?path=<虚拟路径>（新 tab 打开，继续在浏览器内渲染）
 *  - 其它相对链接 → /raw/<虚拟路径>
 */
function renderMarkdown(body, { rootName, dirVirtual }) {
  const md = createMd();
  const defaultImage = md.renderer.rules.image ||
    ((t, i, o, e, s) => s.renderToken(t, i, o));
  const defaultLinkOpen = md.renderer.rules.link_open ||
    ((t, i, o, e, s) => s.renderToken(t, i, o));

  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const src = token.attrGet('src');
    if (src) {
      const resolved = resolveRef(dirVirtual, src, rootName);
      if (resolved) token.attrSet('src', '/raw/' + encodeVP(resolved));
    }
    return defaultImage(tokens, idx, options, env, self);
  };

  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const href = token.attrGet('href');
    if (href) {
      const resolved = resolveRef(dirVirtual, href, rootName);
      if (resolved) {
        const ext = path.extname(resolved).slice(1).toLowerCase();
        if (ext === 'md' || ext === 'markdown' || TEXT_VIEW_EXTS.has(ext)) {
          // md / 文本 → 在查看器里渲染
          token.attrSet('href', '/view?path=' + encodeURIComponent(resolved));
        } else {
          // html / 图片 / 其它 → 原样返回（html 保留上下文目录样式）
          token.attrSet('href', '/raw/' + encodeVP(resolved));
        }
        token.attrSet('target', '_blank');
        token.attrSet('rel', 'noopener');
      }
    }
    return defaultLinkOpen(tokens, idx, options, env, self);
  };

  return md.render(body);
}

function breadcrumb(virtualPath) {
  const segs = String(virtualPath).split('/').filter(Boolean);
  let acc = '';
  let html = '<a href="/">首页</a>';
  for (let i = 0; i < segs.length; i++) {
    acc = acc ? acc + '/' + segs[i] : segs[i];
    if (i === segs.length - 1) {
      html += '<span class="sep">/</span><span class="cur">' + escapeHtml(segs[i]) + '</span>';
    } else {
      html += '<span class="sep">/</span><a href="/?path=' +
        encodeURIComponent(acc) + '">' + escapeHtml(segs[i]) + '</a>';
    }
  }
  return html;
}

/**
 * 生成完整的文档查看页 HTML。
 */
/**
 * 生成完整的文档查看页 HTML。
 *  - embed=true  → 隐藏顶部导航（供 SPA iframe 嵌入时使用）
 *  - theme="dark" → body 加 dark 类，使用深色 CSS 变量
 */
function docPage(opts) {
  const {
    title, virtualPath, mtimeLabel, tags, bodyHtml, rawUrl,
    css, hljsCss, config, embed, theme,
  } = opts;
  const tagHtml = (tags && tags.length)
    ? '<div class="doc-tags">' +
      tags.map((t) => '<span class="doc-tag">' + escapeHtml(String(t)) + '</span>').join('') +
      '</div>'
    : '';
  const siteTitle = escapeHtml((config && config.title) || 'Easy Wiki');
  const bodyClass = theme === 'dark' ? 'dark' : '';
  const htmlClass = theme === 'dark' ? ' class="dark"' : '';

  const header = embed ? '' : (
    '<header class="doc-header">\n' +
    '  <div class="doc-header-inner">\n' +
    '    <a class="doc-back" href="/" target="_top">← 文件浏览</a>\n' +
    '    <div class="doc-crumbs">' + breadcrumb(virtualPath) + '</div>\n' +
    '    <div class="doc-meta">' + (mtimeLabel ? '最后修改：' + escapeHtml(mtimeLabel) : '') + '</div>\n' +
    '    <a class="doc-raw" href="' + rawUrl + '" target="_blank">原始文件</a>\n' +
    '  </div>\n' +
    '</header>\n'
  );

  return '<!DOCTYPE html>\n' +
    '<html lang="zh-CN"' + htmlClass + '>\n' +
    '<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<title>' + escapeHtml(title) + ' · ' + siteTitle + '</title>\n' +
    '<style>' + css + '</style>\n' +
    '<style>' + hljsCss + '</style>\n' +
    '</head>\n' +
    '<body class="' + bodyClass + '">\n' +
    header +
    '<article class="doc-body">\n' +
    '  <h1 class="doc-title">' + escapeHtml(title) + '</h1>\n' +
    tagHtml +
    '  <div class="doc-content">' + bodyHtml + '</div>\n' +
    '</article>\n' +
    '</body>\n' +
    '</html>\n';
}

module.exports = {
  escapeHtml,
  stripFrontmatter,
  encodeVP,
  renderMarkdown,
  highlightText,
  docPage,
};
