(function () {
  'use strict';

  // ─── 状态 ──────────────────────────────────────────────────────
  const state = {
    rootNodes: [],
    config: {},
    tabs: [],              // [{ id, key, path, title, ext, mode, editContent, dom: { iframe, editArea, textarea } }]
    activeTabId: null,
    tabCounter: 0,
    dark: localStorage.getItem('easy-wiki-dark') === '1',
    sidebarWidth: parseInt(localStorage.getItem('easy-wiki-sidebar-width') || '280', 10),
    sidebarCollapsed: localStorage.getItem('easy-wiki-sidebar-collapsed') === '1',
    editAuthenticated: false, // 本次会话内输对一次后不再弹
    editPassword: '',          // 已验证的密码，用于后续保存
    pendingPasswordCallback: null,
    autoTimer: null,
    ctxTarget: null,            // 右键菜单目标文件夹 node
    uploadTarget: null,         // 上传操作的目标文件夹（文件选择是异步的，先暂存）
  };

  // ─── DOM 引用 ──────────────────────────────────────────────────
  const $ = (s) => document.querySelector(s);
  const body = document.body;
  const treeEl = $('#tree');
  const searchEl = $('#search');
  const footEl = $('#foot');
  const tabBarEl = $('#tab-bar');
  const tabContentEl = $('#tab-content');
  const sidebarEl = $('#sidebar');
  const dividerEl = $('#divider');
  const modalEl = $('#password-modal');
  const passwordInputEl = $('#password-input');
  const modalErrorEl = $('#modal-error');
  const editBtnEl = $('#edit-btn');
  const themeBtnEl = $('#theme-toggle');
  const brandEl = $('#brand-title');
  const autoRefreshEl = $('#autorefresh');
  const refreshBtn = $('#refresh');
  const ctxMenuEl = $('#ctx-menu');
  const uploadInputEl = $('#upload-input');

  // 文本类（/view 渲染）
  const TEXT_EXTS = new Set([
    'md', 'markdown', 'txt', 'text', 'json', 'yaml', 'yml', 'csv', 'log',
    'ini', 'conf', 'xml', 'properties', 'sh', 'bat', 'ps1', 'py', 'js',
    'ts', 'jsx', 'tsx', 'css', 'scss', 'less', 'sql', 'java', 'c', 'cpp',
    'h', 'hpp', 'go', 'rs', 'vue',
  ]);
  // 可编辑类（在文本类基础上加 html）
  const EDITABLE_EXTS = new Set([...TEXT_EXTS, 'html', 'htm']);

  const enc = (p) => encodeURIComponent(p);
  const encVP = (p) => p.split('/').map(encodeURIComponent).join('/');

  // ─── 工具 ──────────────────────────────────────────────────────
  async function api(path) {
    const r = await fetch('/api/tree?path=' + enc(path));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  async function apiConfig() {
    const r = await fetch('/api/config');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  function fmtSize(n) {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }
  function fmtTime(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function iframeSrcFor(tab) {
    const theme = state.dark ? 'dark' : 'light';
    if (TEXT_EXTS.has(tab.ext)) {
      return `/view?path=${enc(tab.path)}&embed=1&theme=${theme}`;
    }
    return `/raw/${encVP(tab.path)}`;
  }

  function iconFor(node) {
    if (node.type === 'dir') return node.open ? '📂' : '📁';
    const ext = node.ext || '';
    if (ext === 'md' || ext === 'markdown') return '📝';
    if (ext === 'html' || ext === 'htm') return '🌐';
    if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'avif'].includes(ext)) return '🖼️';
    if (ext === 'pdf') return '📕';
    if (['txt', 'text', 'log'].includes(ext)) return '📄';
    if (['json', 'yaml', 'yml', 'xml', 'ini', 'conf', 'properties'].includes(ext)) return '⚙️';
    if (['js', 'ts', 'jsx', 'tsx', 'css', 'scss', 'less', 'py', 'java', 'c', 'cpp', 'h', 'go', 'rs', 'sql', 'sh', 'bat', 'vue'].includes(ext)) return '💻';
    return '📃';
  }

  function toast(msg, type) {
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 2000);
    setTimeout(() => el.remove(), 2500);
  }

  // ─── 文件树 ────────────────────────────────────────────────────
  function toggleNode(node) {
    if (node.children == null) {
      node.loading = true;
      renderTree();
      api(node.path).then((data) => {
        node.children = data.nodes.map((n) => ({ ...n, children: null, open: false }));
        node.loading = false;
        node.open = true;
        renderTree();
      }).catch(() => {
        node.children = [];
        node.loading = false;
        renderTree();
      });
      return;
    }
    node.open = !node.open;
    renderTree();
  }

  function onNodeClick(node) {
    if (node.type === 'dir') { toggleNode(node); return; }
    openFile(node);
  }

  async function expandRecursive(nodes) {
    for (const n of nodes) {
      if (n.type !== 'dir') continue;
      if (n.children == null) {
        try {
          const data = await api(n.path);
          n.children = data.nodes.map((x) => ({ ...x, children: null, open: false }));
        } catch (_) { n.children = []; }
      }
      n.open = true;
      await expandRecursive(n.children);
    }
  }

  async function revealPath(vp) {
    const segs = vp.split('/').filter(Boolean);
    let nodes = state.rootNodes;
    let acc = '';
    for (let i = 0; i < segs.length; i++) {
      acc = acc ? acc + '/' + segs[i] : segs[i];
      let cur = nodes.find((n) => n.path === acc) || nodes.find((n) => n.name === segs[i]);
      if (!cur) break;
      if (cur.type !== 'dir') break;
      if (cur.children == null) {
        try {
          const data = await api(cur.path);
          cur.children = data.nodes.map((x) => ({ ...x, children: null, open: false }));
        } catch (_) { cur.children = []; }
      }
      cur.open = true;
      nodes = cur.children;
    }
  }

  async function refreshTreePreserving() {
    const openPaths = [];
    const collect = (nodes) => nodes.forEach((n) => {
      if (n.type === 'dir' && n.open) { openPaths.push(n.path); collect(n.children || []); }
    });
    collect(state.rootNodes);
    try {
      const data = await api('');
      state.rootNodes = data.nodes.map((n) => ({ ...n, children: null, open: false }));
    } catch (_) { return; }
    for (const p of openPaths) await revealPath(p);
    renderTree();
    updateFoot();
  }

  function countFiles(nodes) {
    let c = 0;
    for (const n of nodes) {
      if (n.type === 'file') c++;
      else if (n.children) c += countFiles(n.children);
    }
    return c;
  }

  function buildNode(node, depth, term) {
    const selfMatch = !term || node.name.toLowerCase().includes(term);
    const childEls = [];
    let childMatch = false;
    if (node.type === 'dir' && node.open && node.children) {
      for (const c of node.children) {
        const ce = buildNode(c, depth + 1, term);
        if (ce) { childEls.push(ce); childMatch = true; }
      }
    }
    const show = term ? (selfMatch || childMatch) : true;
    if (!show) return null;

    const row = document.createElement('div');
    row.className = 'row ' + (node.type === 'dir' ? 'dir' : 'file');
    row.style.paddingLeft = (depth * 16 + 8) + 'px';

    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = iconFor(node);
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = node.name;
    if (term && node.name.toLowerCase().includes(term)) name.classList.add('hit');
    const meta = document.createElement('span');
    meta.className = 'meta';
    // 行内只显示文件大小；完整信息放在 title 里悬浮查看
    meta.textContent = node.type === 'file' ? fmtSize(node.size) : (node.loading ? '加载中…' : '');

    const tooltip = [];
    if (node.type === 'dir') {
      tooltip.push('📁 文件夹');
    } else {
      tooltip.push('📄 文件');
      if (node.size != null) tooltip.push('大小：' + fmtSize(node.size));
      if (node.ext) tooltip.push('类型：.' + node.ext);
    }
    if (node.mtime) tooltip.push('修改：' + fmtTime(node.mtime));
    tooltip.push('路径：' + node.path);
    row.title = tooltip.join('\n');

    row.appendChild(icon); row.appendChild(name); row.appendChild(meta);
    row.addEventListener('click', () => onNodeClick(node));
    if (node.type === 'dir') {
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showCtxMenu(e.clientX, e.clientY, node);
      });
    }

    if (node.type === 'dir' && node.open && childEls.length) {
      const cont = document.createElement('div');
      cont.className = 'children';
      childEls.forEach((e) => cont.appendChild(e));
      const wrap = document.createElement('div');
      wrap.appendChild(row); wrap.appendChild(cont);
      return wrap;
    }
    return row;
  }

  function renderTree() {
    const term = searchEl.value.trim().toLowerCase();
    treeEl.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const n of state.rootNodes) {
      const el = buildNode(n, 0, term);
      if (el) frag.appendChild(el);
    }
    treeEl.appendChild(frag);
  }
  function updateFoot() {
    const term = searchEl.value.trim();
    footEl.textContent = `${countFiles(state.rootNodes)} 个文件` + (term ? ` · 过滤「${term}」` : '');
  }

  function debounce(fn, ms) {
    let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }
  function onSearch() {
    const term = searchEl.value.trim();
    if (term) expandRecursive(state.rootNodes).then(renderTree);
    else { renderTree(); }
    updateFoot();
  }

  // ─── Tab 管理 ──────────────────────────────────────────────────
  function tabKeyFor(mode, file) {
    if (mode === 'single') return 'single';
    if (mode === 'perType') return 'type-' + (file.ext || '__noext');
    return 'path-' + file.path;
  }

  function createTabDom(tab) {
    const iframe = document.createElement('iframe');
    iframe.className = 'doc-iframe';
    iframe.src = iframeSrcFor(tab);
    iframe.setAttribute('allow', '');

    const editArea = document.createElement('div');
    editArea.className = 'edit-area';
    editArea.innerHTML = `
      <div class="edit-toolbar">
        <span>📝 编辑模式</span>
        <span class="edit-path">${tab.path}</span>
        <button class="cancel" data-action="cancel">退出编辑</button>
        <button class="save" data-action="save">💾 保存</button>
      </div>
      <textarea class="edit-textarea" spellcheck="false"></textarea>
    `;
    editArea.querySelector('[data-action="cancel"]').addEventListener('click', () => exitEditMode(false));
    editArea.querySelector('[data-action="save"]').addEventListener('click', () => saveEdit());
    return { iframe, editArea, textarea: editArea.querySelector('textarea') };
  }

  function createTab(file, key) {
    const id = ++state.tabCounter;
    const tab = {
      id,
      key,
      path: file.path,
      title: file.name,
      ext: file.ext || '',
      mode: 'view',
      editContent: '',
    };
    tab.dom = createTabDom(tab);
    tabContentEl.appendChild(tab.dom.iframe);
    tabContentEl.appendChild(tab.dom.editArea);
    state.tabs.push(tab);
    state.activeTabId = id;
    renderTabs();
    renderTabContent();
    updateEditBtn();
    return tab;
  }

  function updateTab(tab, file) {
    tab.path = file.path;
    tab.title = file.name;
    tab.ext = file.ext || '';
    tab.mode = 'view';
    tab.editContent = '';
    tab.dom.iframe.src = iframeSrcFor(tab);
    tab.dom.editArea.classList.remove('active');
    renderTabs();
    renderTabContent();
    updateEditBtn();
  }

  function closeTab(id) {
    const idx = state.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const tab = state.tabs[idx];
    tab.dom.iframe.remove();
    tab.dom.editArea.remove();
    state.tabs.splice(idx, 1);
    if (state.activeTabId === id) {
      if (state.tabs.length === 0) {
        state.activeTabId = null;
      } else {
        // 激活相邻
        state.activeTabId = state.tabs[Math.min(idx, state.tabs.length - 1)].id;
      }
    }
    renderTabs();
    renderTabContent();
    updateEditBtn();
  }

  function activateTab(id) {
    if (state.activeTabId === id) return;
    state.activeTabId = id;
    renderTabs();
    renderTabContent();
    updateEditBtn();
  }

  function openFile(file) {
    const mode = state.config.tabMode || 'multi';
    const key = tabKeyFor(mode, file);
    const existing = state.tabs.find((t) => t.key === key);
    if (existing) {
      if (mode === 'single' || mode === 'perType') {
        // 替换内容
        updateTab(existing, file);
      } else {
        activateTab(existing.id);
      }
      return;
    }
    const tab = createTab(file, key);
    // FIFO 淘汰
    if (mode === 'multi' && state.tabs.length > (state.config.maxTabs || 10)) {
      closeTab(state.tabs[0].id);
    }
    activateTab(tab.id);
  }

  function renderTabs() {
    tabBarEl.innerHTML = '';
    if (state.tabs.length === 0) {
      tabBarEl.style.display = 'none';
      return;
    }
    tabBarEl.style.display = 'flex';
    for (const tab of state.tabs) {
      const el = document.createElement('div');
      el.className = 'tab' + (tab.id === state.activeTabId ? ' active' : '');
      const icon = document.createElement('span');
      icon.className = 'tab-icon';
      icon.textContent = iconFor({ type: 'file', ext: tab.ext });
      const title = document.createElement('span');
      title.className = 'tab-title';
      title.textContent = tab.title;
      if (tab.mode === 'edit') title.classList.add('tab-editing');
      const close = document.createElement('span');
      close.className = 'tab-close';
      close.textContent = '✕';
      close.title = '关闭';
      close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(tab.id); });
      el.appendChild(icon); el.appendChild(title); el.appendChild(close);
      el.addEventListener('click', () => activateTab(tab.id));
      tabBarEl.appendChild(el);
    }
  }

  function renderTabContent() {
    // 隐藏所有 iframe 和 edit-area
    for (const tab of state.tabs) {
      tab.dom.iframe.classList.remove('active');
      tab.dom.editArea.classList.remove('active');
    }
    const active = state.tabs.find((t) => t.id === state.activeTabId);
    if (!active) {
      showEmptyState();
      return;
    }
    hideEmptyState();
    if (active.mode === 'edit') {
      active.dom.editArea.classList.add('active');
    } else {
      active.dom.iframe.classList.add('active');
    }
  }

  let emptyStateEl = null;
  function showEmptyState() {
    if (!emptyStateEl) {
      emptyStateEl = document.createElement('div');
      emptyStateEl.className = 'empty-state';
      emptyStateEl.innerHTML = '<div><div class="big">📚</div><div>从左侧文件树中点击一个文件开始浏览</div></div>';
      tabContentEl.appendChild(emptyStateEl);
    }
    emptyStateEl.style.display = 'flex';
  }
  function hideEmptyState() {
    if (emptyStateEl) emptyStateEl.style.display = 'none';
  }

  // ─── 编辑模式 ──────────────────────────────────────────────────
  function activeTab() { return state.tabs.find((t) => t.id === state.activeTabId); }

  function updateEditBtn() {
    const tab = activeTab();
    const enabled = state.config.editEnabled && tab && tab.mode === 'view' && EDITABLE_EXTS.has(tab.ext);
    const editing = tab && tab.mode === 'edit';
    editBtnEl.hidden = !tab || !EDITABLE_EXTS.has(tab.ext || '') || !state.config.editEnabled;
    editBtnEl.textContent = editing ? '✓ 退出编辑' : '编辑';
    editBtnEl.classList.toggle('editing', !!editing);
  }

  function enterEditMode() {
    const tab = activeTab();
    if (!tab) return;
    // 加载原始内容
    fetch('/raw/' + encVP(tab.path))
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then((text) => {
        tab.mode = 'edit';
        tab.editContent = text;
        tab.dom.textarea.value = text;
        renderTabContent();
        updateEditBtn();
        tab.dom.textarea.focus();
      })
      .catch((e) => toast('加载失败：' + e.message, 'error'));
  }

  function exitEditMode(discardWarning) {
    const tab = activeTab();
    if (!tab || tab.mode !== 'edit') return;
    // 检查是否有未保存修改
    if (discardWarning && tab.dom.textarea.value !== tab.editContent) {
      if (!confirm('有未保存的修改，确定退出？')) return;
    }
    tab.mode = 'view';
    tab.editContent = '';
    // 重新加载 iframe（可能内容已更新）
    tab.dom.iframe.src = iframeSrcFor(tab);
    renderTabContent();
    updateEditBtn();
  }

  async function saveEdit() {
    const tab = activeTab();
    if (!tab || tab.mode !== 'edit') return;
    const content = tab.dom.textarea.value;
    try {
      const r = await fetch('/api/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: tab.path, password: state.editPassword, content }),
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || '保存失败');
      tab.editContent = content;
      toast('已保存 ✓', 'success');
    } catch (e) {
      toast('保存失败：' + e.message, 'error');
    }
  }

  // ─── 密码弹窗 ──────────────────────────────────────────────────
  function showPasswordModal(onOk) {
    if (state.editAuthenticated) {
      onOk();
      return;
    }
    passwordInputEl.value = '';
    modalErrorEl.textContent = '';
    modalEl.hidden = false;
    setTimeout(() => passwordInputEl.focus(), 50);
    state.pendingPasswordCallback = onOk;
  }
  function hidePasswordModal() {
    modalEl.hidden = true;
    state.pendingPasswordCallback = null;
  }
  async function confirmPassword() {
    const pwd = passwordInputEl.value;
    modalErrorEl.textContent = '';
    // 尝试一次保存空内容以验证密码
    try {
      const r = await fetch('/api/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '__auth_check__', password: pwd, content: '' }),
      });
      const data = await r.json();
      // 服务端会返回 404（路径不存在）但密码正确；或 403（密码错误）
      if (r.status === 403) {
        modalErrorEl.textContent = '密码错误';
        passwordInputEl.select();
        return;
      }
      // 密码正确（其它错误也说明密码对了）
      state.editAuthenticated = true;
      state.editPassword = pwd;
      const cb = state.pendingPasswordCallback;
      hidePasswordModal();
      if (cb) cb();
    } catch (e) {
      modalErrorEl.textContent = '网络错误：' + e.message;
    }
  }

  // ─── 右键上下文菜单 ─────────────────────────────────────────────
  function showCtxMenu(x, y, node) {
    state.ctxTarget = node;
    ctxMenuEl.hidden = false;
    // 定位（避免超出视口）
    const mw = ctxMenuEl.offsetWidth || 160;
    const mh = ctxMenuEl.offsetHeight || 80;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    ctxMenuEl.style.left = (x + mw > vw ? vw - mw - 4 : x) + 'px';
    ctxMenuEl.style.top = (y + mh > vh ? vh - mh - 4 : y) + 'px';
  }
  function hideCtxMenu() {
    ctxMenuEl.hidden = true;
    state.ctxTarget = null;
  }

  function ensureAuthThen(cb) {
    // 每次操作都要求输入密码（与编辑共用同一密码）
    showPasswordModal(cb);
  }

  async function doMkdir(target) {
    if (!target) return;
    const name = prompt('新建文件夹到 ' + target.path + '\n请输入文件夹名：');
    if (!name || !name.trim()) return;
    try {
      const r = await fetch('/api/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: target.path, password: state.editPassword, name: name.trim() }),
      });
      const data = await r.json();
      if (data.ok) {
        toast('📁 已创建：' + name.trim());
        refreshTreePreserving();
      } else {
        toast('创建失败：' + (data.error || '未知错误'), 'error');
      }
    } catch (e) {
      toast('网络错误：' + e.message, 'error');
    }
  }

  async function doUpload(files, target) {
    if (!target || !files.length) return;
    let done = 0;
    for (const file of files) {
      try {
        const buf = await file.arrayBuffer();
        const u8 = new Uint8Array(buf);
        // 分块转 base64，避免大文件 spread 爆栈
        let binary = '';
        const chunkSize = 8192;
        for (let i = 0; i < u8.length; i += chunkSize) {
          binary += String.fromCharCode.apply(null, u8.subarray(i, i + chunkSize));
        }
        const b64 = btoa(binary);
        const r = await fetch('/api/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: target.path,
            password: state.editPassword,
            name: file.name,
            content: b64,
          }),
        });
        const data = await r.json();
        if (data.ok) {
          done++;
        } else {
          toast(file.name + ' 失败：' + (data.error || '未知错误'), 'error');
        }
      } catch (e) {
        toast(file.name + ' 上传错误：' + e.message, 'error');
      }
    }
    if (done) {
      toast('📤 已上传 ' + done + ' 个文件');
      refreshTreePreserving();
    }
  }

  // ─── 侧栏 ─────────────────────────────────────────────────────
  function applySidebarState() {
    sidebarEl.style.width = state.sidebarWidth + 'px';
    sidebarEl.classList.toggle('collapsed', state.sidebarCollapsed);
  }
  function toggleSidebar() {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    localStorage.setItem('easy-wiki-sidebar-collapsed', state.sidebarCollapsed ? '1' : '0');
    applySidebarState();
  }

  function initDivider() {
    let dragging = false, startX = 0, startW = 0;
    let overlay = null;

    function beginDrag(e) {
      if (state.sidebarCollapsed) return;
      dragging = true;
      startX = e.clientX;
      startW = state.sidebarWidth;
      dividerEl.classList.add('dragging');
      sidebarEl.classList.add('dragging');       // 禁用 sidebar transition，避免拖拽粘滞
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      // 铺一层透明遮罩：防止 iframe / 其它元素抢走 mouse 事件
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'drag-overlay';
      }
      document.body.appendChild(overlay);

      e.preventDefault();
    }

    function onDrag(e) {
      if (!dragging) return;
      const delta = e.clientX - startX;
      const w = Math.max(180, Math.min(500, startW + delta));
      state.sidebarWidth = w;
      sidebarEl.style.width = w + 'px';
    }

    function endDrag() {
      if (!dragging) return;
      dragging = false;
      dividerEl.classList.remove('dragging');
      sidebarEl.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (overlay && overlay.parentNode) overlay.remove();
      localStorage.setItem('easy-wiki-sidebar-width', String(state.sidebarWidth));
    }

    dividerEl.addEventListener('mousedown', beginDrag);
    window.addEventListener('mousemove', onDrag);
    window.addEventListener('mouseup', endDrag);
    // 窗口失焦时也收尾，防止异常状态残留
    window.addEventListener('blur', endDrag);
  }

  // ─── 暗色模式 ──────────────────────────────────────────────────
  function applyTheme() {
    body.classList.toggle('dark', state.dark);
    themeBtnEl.textContent = state.dark ? '☀️' : '🌙';
    localStorage.setItem('easy-wiki-dark', state.dark ? '1' : '0');
    // 刷新所有 iframe 的 src（theme 参数变了）
    for (const tab of state.tabs) {
      if (TEXT_EXTS.has(tab.ext)) {
        tab.dom.iframe.src = iframeSrcFor(tab);
      }
    }
  }
  function toggleTheme() {
    state.dark = !state.dark;
    applyTheme();
  }

  // ─── 事件绑定 ──────────────────────────────────────────────────
  $('#sidebar-toggle').addEventListener('click', toggleSidebar);
  refreshBtn.addEventListener('click', refreshTreePreserving);
  searchEl.addEventListener('input', debounce(onSearch, 300));
  themeBtnEl.addEventListener('click', toggleTheme);
  editBtnEl.addEventListener('click', () => {
    const tab = activeTab();
    if (!tab) return;
    if (tab.mode === 'edit') {
      exitEditMode(true);
      return;
    }
    showPasswordModal(enterEditMode);
  });

  autoRefreshEl.addEventListener('change', () => {
    clearInterval(state.autoTimer);
    if (autoRefreshEl.checked) {
      state.autoTimer = setInterval(refreshTreePreserving, 15000);
    }
  });

  // 密码弹窗
  $('#password-cancel').addEventListener('click', hidePasswordModal);
  $('#password-confirm').addEventListener('click', confirmPassword);
  passwordInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmPassword();
    if (e.key === 'Escape') hidePasswordModal();
  });
  modalEl.addEventListener('click', (e) => { if (e.target === modalEl) hidePasswordModal(); });

  // 右键上下文菜单
  ctxMenuEl.addEventListener('click', (e) => {
    const item = e.target.closest('.ctx-item');
    if (!item) return;
    const action = item.dataset.action;
    // 先捕获目标（hideCtxMenu 会清空 state.ctxTarget）
    const target = state.ctxTarget;
    hideCtxMenu();
    if (!target) return;
    if (action === 'mkdir') {
      ensureAuthThen(() => doMkdir(target));
    } else if (action === 'upload') {
      // 文件选择是异步的，先把目标存到专用字段
      ensureAuthThen(() => { state.uploadTarget = target; uploadInputEl.click(); });
    }
  });
  // 点击其它地方关闭菜单
  document.addEventListener('click', (e) => {
    if (!ctxMenuEl.hidden && !ctxMenuEl.contains(e.target)) hideCtxMenu();
  });
  window.addEventListener('scroll', hideCtxMenu, true);
  // 文件选择后上传
  uploadInputEl.addEventListener('change', () => {
    if (uploadInputEl.files.length) {
      const target = state.uploadTarget;
      state.uploadTarget = null;
      doUpload(Array.from(uploadInputEl.files), target);
      uploadInputEl.value = '';
    }
  });

  // 键盘快捷键
  window.addEventListener('keydown', (e) => {
    // Ctrl/Cmd + S 保存（在编辑模式下）
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      const tab = activeTab();
      if (tab && tab.mode === 'edit') {
        e.preventDefault();
        saveEdit();
      }
    }
    // Ctrl/Cmd + W 关闭当前 tab
    if ((e.ctrlKey || e.metaKey) && e.key === 'w') {
      if (activeTab()) {
        e.preventDefault();
        closeTab(state.activeTabId);
      }
    }
  });

  // ─── 初始化 ────────────────────────────────────────────────────
  async function init() {
    applyTheme();
    applySidebarState();
    initDivider();

    try {
      const [treeData, cfg] = await Promise.all([
        api(''),
        apiConfig().catch(() => ({})),
      ]);
      state.rootNodes = treeData.nodes.map((n) => ({ ...n, children: null, open: false }));
      state.config = cfg;
      if (cfg.title) { brandEl.textContent = cfg.title; document.title = cfg.title; }
      if (cfg.autoRefreshSeconds > 0) {
        autoRefreshEl.checked = true;
        state.autoTimer = setInterval(refreshTreePreserving, cfg.autoRefreshSeconds * 1000);
      }
    } catch (e) {
      treeEl.innerHTML = '<div class="error">无法加载文件树：' + e.message + '</div>';
      return;
    }

    // 初始深链
    const vp = new URLSearchParams(location.search).get('path');
    if (vp) {
      await revealPath(vp);
      // 若指向文件，则打开
      const segs = vp.split('/').filter(Boolean);
      let nodes = state.rootNodes, target = null;
      for (let i = 0; i < segs.length; i++) {
        const seg = segs.slice(0, i + 1).join('/');
        const found = nodes.find((n) => n.path === seg);
        if (!found) break;
        if (i === segs.length - 1 && found.type === 'file') target = found;
        else if (found.children) nodes = found.children;
        else break;
      }
      if (target) openFile(target);
    }

    renderTree();
    renderTabs();
    renderTabContent();
    updateEditBtn();
    updateFoot();
  }

  init();
})();
