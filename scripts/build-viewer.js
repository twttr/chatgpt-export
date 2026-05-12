#!/usr/bin/env node
/**
 * Build a self-contained HTML viewer for the merged ChatGPT export.
 *
 * Reads the merged folder produced by merge-export.js and emits a single
 * `viewer.html` at its root. Open the HTML directly (file://) — it embeds
 * all conversation data and references attachments via relative paths.
 *
 * Usage: node build-viewer.js <merged-dir>
 */

const fs = require('fs');
const path = require('path');

function sanitize(s) {
  if (!s) return 'untitled';
  return s.replace(/[\/\\:*?"<>|\n\r\t]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100) || 'untitled';
}

function tsToNum(ts) {
  if (!ts) return 0;
  if (typeof ts === 'number') return ts * 1000;
  const t = Date.parse(ts);
  return isNaN(t) ? 0 : t;
}

function detectExt(filepath) {
  const fd = fs.openSync(filepath, 'r');
  const buf = Buffer.alloc(16);
  try { fs.readSync(fd, buf, 0, 16, 0); } finally { fs.closeSync(fd); }
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp';
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'pdf';
  if (buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04) return 'zip';
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return 'mp3';
  return null;
}

function fixExtension(dir, filename) {
  if (/\.[a-zA-Z0-9]{1,5}$/.test(filename)) return filename;
  const ext = detectExt(path.join(dir, filename));
  if (!ext) return filename;
  const newName = filename + '.' + ext;
  fs.renameSync(path.join(dir, filename), path.join(dir, newName));
  return newName;
}

const mergedDir = process.argv[2];
if (!mergedDir) {
  console.error('Usage: node build-viewer.js <merged-dir>');
  process.exit(1);
}

const root = path.resolve(mergedDir);
console.log('Scanning ' + root + '...');

const projects = [];
for (const projName of fs.readdirSync(root)) {
  const projPath = path.join(root, projName);
  if (!fs.statSync(projPath).isDirectory()) continue;
  const conversations = [];
  for (const convFolder of fs.readdirSync(projPath)) {
    const convPath = path.join(projPath, convFolder);
    if (!fs.statSync(convPath).isDirectory()) continue;
    const jsonPath = path.join(convPath, 'conversation.json');
    if (!fs.existsSync(jsonPath)) continue;
    const conv = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const rawFiles = fs.readdirSync(convPath)
      .filter(f => f !== 'conversation.json' && !f.startsWith('.'));
    const files = rawFiles.map(f => fixExtension(convPath, f));
    conversations.push({
      folder: convFolder,
      id: conv.id,
      title: conv.title || 'Untitled',
      create_time: conv.create_time,
      update_time: conv.update_time,
      mapping: conv.conversation ? conv.conversation.mapping : {},
      current_node: conv.conversation ? conv.conversation.current_node : null,
      files,
    });
  }
  conversations.sort((a, b) => tsToNum(b.update_time) - tsToNum(a.update_time));
  if (conversations.length > 0) projects.push({ name: projName, conversations });
}

projects.sort((a, b) => a.name.localeCompare(b.name));

const totalConvs = projects.reduce((acc, p) => acc + p.conversations.length, 0);
console.log(`Found ${projects.length} project(s), ${totalConvs} conversation(s).`);

const dataJson = JSON.stringify(projects).replace(/</g, '\\u003c');

const markedPath = path.join(__dirname, '..', 'node_modules', 'marked', 'lib', 'marked.umd.js');
const markedSource = fs.readFileSync(markedPath, 'utf8');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>ChatGPT Export Viewer</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #212121; color: #ececec; }
  body { display: flex; height: 100vh; overflow: hidden; }
  .sidebar { width: 320px; min-width: 320px; background: #171717; border-right: 1px solid #2d2d2d; display: flex; flex-direction: column; }
  .sidebar-header { padding: 14px 16px; border-bottom: 1px solid #2d2d2d; }
  .sidebar-header h1 { font-size: 14px; font-weight: 600; color: #b4b4b4; }
  .sidebar-header .stats { font-size: 11px; color: #6f6f6f; margin-top: 2px; }
  .search { padding: 10px 12px; border-bottom: 1px solid #2d2d2d; }
  .search input { width: 100%; padding: 8px 12px; background: #2d2d2d; border: 1px solid #404040; border-radius: 8px; color: #ececec; font-size: 13px; outline: none; }
  .search input:focus { border-color: #565869; }
  .conv-list { flex: 1; overflow-y: auto; padding: 8px; }
  .project { margin-bottom: 12px; }
  .project-name { padding: 6px 8px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #8e8e8e; display: flex; justify-content: space-between; align-items: center; }
  .project-name .count { font-weight: 400; opacity: 0.7; }
  .conv-item { padding: 8px 10px; border-radius: 6px; cursor: pointer; font-size: 13px; color: #d4d4d4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .conv-item:hover { background: #2a2a2a; }
  .conv-item.active { background: #303030; color: #fff; }
  .conv-item .badge { display: inline-block; font-size: 10px; padding: 1px 5px; background: #404040; border-radius: 4px; margin-right: 4px; color: #b4b4b4; vertical-align: middle; }
  .main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  .main-header { padding: 16px 24px; border-bottom: 1px solid #2d2d2d; }
  .main-header h2 { font-size: 16px; font-weight: 600; color: #ececec; }
  .main-header .meta { font-size: 12px; color: #8e8e8e; margin-top: 4px; }
  .messages { flex: 1; overflow-y: auto; padding: 24px 0; }
  .empty { display: flex; height: 100%; align-items: center; justify-content: center; color: #6f6f6f; font-size: 14px; }
  .msg { padding: 16px 24px; max-width: 768px; margin: 0 auto; }
  .msg-role { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #8e8e8e; margin-bottom: 6px; font-weight: 600; }
  .msg-user .msg-role { color: #a3d8ff; }
  .msg-assistant .msg-role { color: #b6e9c1; }
  .msg-tool .msg-role { color: #ffd29a; }
  .msg-system .msg-role { color: #aaa; }
  .msg-content { font-size: 15px; line-height: 1.6; color: #ececec; word-wrap: break-word; }
  .msg-content > *:first-child { margin-top: 0; }
  .msg-content > *:last-child { margin-bottom: 0; }
  .msg-content p { margin: 0.6em 0; }
  .msg-content h1, .msg-content h2, .msg-content h3, .msg-content h4, .msg-content h5, .msg-content h6 { margin: 1.2em 0 0.5em; line-height: 1.3; font-weight: 600; color: #fff; }
  .msg-content h1 { font-size: 1.6em; }
  .msg-content h2 { font-size: 1.4em; }
  .msg-content h3 { font-size: 1.2em; }
  .msg-content h4 { font-size: 1.05em; }
  .msg-content code { background: #2d2d2d; padding: 2px 5px; border-radius: 4px; font-family: 'SF Mono', Menlo, monospace; font-size: 13px; }
  .msg-content pre { background: #0d0d0d; padding: 12px; border-radius: 8px; overflow-x: auto; margin: 8px 0; }
  .msg-content pre code { background: none; padding: 0; font-size: 13px; line-height: 1.45; }
  .msg-content a { color: #7eb8da; text-decoration: underline; }
  .msg-content strong { font-weight: 600; color: #fff; }
  .msg-content em { font-style: italic; }
  .msg-content blockquote { border-left: 3px solid #404040; margin: 0.6em 0; padding: 0.3em 0 0.3em 14px; color: #b4b4b4; }
  .msg-content ul, .msg-content ol { margin: 0.6em 0; padding-left: 24px; }
  .msg-content li { margin: 0.25em 0; }
  .msg-content li > p { margin: 0.3em 0; }
  .msg-content hr { border: none; border-top: 1px solid #2d2d2d; margin: 1em 0; }
  .msg-content table { border-collapse: collapse; margin: 12px 0; font-size: 14px; max-width: 100%; }
  .msg-content th, .msg-content td { border: 1px solid #404040; padding: 7px 12px; text-align: left; vertical-align: top; }
  .msg-content th { background: #2a2a2a; font-weight: 600; }
  .msg-content tr:nth-child(even) td { background: #1f1f1f; }
  .msg-content del { text-decoration: line-through; opacity: 0.7; }
  .msg-content img { max-width: 100%; border-radius: 8px; margin: 6px 0; }
  .msg-attachments { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 8px; }
  .msg-attachments img { max-width: 320px; max-height: 320px; border-radius: 8px; border: 1px solid #2d2d2d; cursor: pointer; }
  .msg-attachments .file-link { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; background: #2d2d2d; border-radius: 6px; text-decoration: none; color: #d4d4d4; font-size: 12px; }
  .msg-attachments .file-link:hover { background: #3a3a3a; }
  .conv-files { padding: 12px 24px; max-width: 768px; margin: 0 auto; border-top: 1px dashed #2d2d2d; }
  .conv-files-label { font-size: 11px; color: #6f6f6f; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
  .conv-files-list { display: flex; flex-wrap: wrap; gap: 8px; }
  .conv-files-list a, .conv-files-list img { display: inline-flex; }
  .conv-files-list img { max-width: 160px; max-height: 160px; border-radius: 6px; border: 1px solid #2d2d2d; cursor: pointer; }
  .conv-files-list a.file-link { padding: 6px 10px; background: #2d2d2d; border-radius: 6px; text-decoration: none; color: #d4d4d4; font-size: 12px; }
  .conv-files-list a.file-link:hover { background: #3a3a3a; }
  .lightbox { position: fixed; inset: 0; background: rgba(0,0,0,0.92); display: none; align-items: center; justify-content: center; z-index: 9999; cursor: zoom-out; }
  .lightbox.open { display: flex; }
  .lightbox img { max-width: 92vw; max-height: 92vh; object-fit: contain; border-radius: 4px; }
  .lightbox-close { position: absolute; top: 16px; right: 20px; background: none; border: none; color: #fff; font-size: 28px; cursor: pointer; opacity: 0.7; }
  .lightbox-close:hover { opacity: 1; }
  img.zoomable { cursor: zoom-in; transition: opacity 0.15s; }
  img.zoomable:hover { opacity: 0.9; }
</style>
</head>
<body>
  <aside class="sidebar">
    <div class="sidebar-header">
      <h1>ChatGPT Export</h1>
      <div class="stats" id="stats"></div>
    </div>
    <div class="search">
      <input id="searchInput" type="search" placeholder="Search conversations...">
    </div>
    <div id="convList" class="conv-list"></div>
  </aside>
  <main class="main">
    <div class="main-header" id="mainHeader" style="display:none">
      <h2 id="convTitle"></h2>
      <div class="meta" id="convMeta"></div>
    </div>
    <div id="messages" class="messages">
      <div class="empty">Select a conversation</div>
    </div>
  </main>

  <div id="lightbox" class="lightbox">
    <button id="lightboxClose" class="lightbox-close" aria-label="Close">&times;</button>
    <img id="lightboxImg" alt="">
  </div>

<script id="data" type="application/json">${dataJson}</script>
<script>
${markedSource}
</script>
<script>
(function () {
  'use strict';

  const data = JSON.parse(document.getElementById('data').textContent);

  const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'];
  const convListEl = document.getElementById('convList');
  const messagesEl = document.getElementById('messages');
  const mainHeader = document.getElementById('mainHeader');
  const convTitleEl = document.getElementById('convTitle');
  const convMetaEl = document.getElementById('convMeta');
  const statsEl = document.getElementById('stats');
  const searchInput = document.getElementById('searchInput');

  const totalConvs = data.reduce((acc, p) => acc + p.conversations.length, 0);
  statsEl.textContent = data.length + ' projects · ' + totalConvs + ' conversations';

  function fmtDate(ts) {
    if (!ts) return '';
    const d = typeof ts === 'number' ? new Date(ts * 1000) : new Date(ts);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function isImage(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    return IMAGE_EXTS.includes(ext);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  function cleanText(text) {
    if (!text) return '';
    text = text.replace(/citeturn\\d+\\w+\\d+\\.?/g, '');
    text = text.replace(/【[^】]*†[^】]*】/g, '');
    text = text.replace(/[\\uE000-\\uF8FF]/g, '');
    text = text.replace(/<PARSED TEXT[^>]*>/g, '');
    text = text.replace(/<END OF PARSED TEXT>/g, '');
    text = text.replace(/Make sure to include 【[^】]*】 markers[^.]*\\./g, '');
    return text.trim();
  }

  marked.setOptions({ gfm: true, breaks: true });

  function renderText(text) {
    if (!text) return '';
    return marked.parse(text);
  }

  function collectMessages(conv) {
    const mapping = conv.mapping || {};
    const result = [];
    let nodeId = conv.current_node;
    // Walk from current_node up to root, collecting
    while (nodeId && mapping[nodeId]) {
      const node = mapping[nodeId];
      if (node.message) result.unshift(node.message);
      nodeId = node.parent;
    }
    return result;
  }

  function messageText(msg) {
    if (!msg || !msg.content) return '';
    const parts = msg.content.parts;
    if (!parts) return '';
    return parts.map(p => {
      if (typeof p === 'string') return p;
      if (p && typeof p === 'object' && p.text) return p.text;
      return '';
    }).join('\\n').trim();
  }

  function renderConversation(projectName, conv) {
    convTitleEl.textContent = conv.title;
    convMetaEl.textContent = projectName + ' · ' +
      (conv.update_time ? 'Updated ' + fmtDate(conv.update_time) : '') +
      (conv.create_time ? ' · Created ' + fmtDate(conv.create_time) : '');
    mainHeader.style.display = 'block';

    const messages = collectMessages(conv);
    if (messages.length === 0) {
      messagesEl.innerHTML = '<div class="empty">No messages in this conversation.</div>';
      return;
    }

    const filesByFolder = (conv.files || []).map(f => encodeURIComponent(projectName) + '/' + encodeURIComponent(conv.folder) + '/' + encodeURIComponent(f));

    let html = '';
    for (const msg of messages) {
      const role = (msg.author && msg.author.role) || msg.role || 'unknown';
      // Skip system messages, hidden messages, and tool calls (non-user-facing)
      if (role === 'system' || role === 'tool') continue;
      if (msg.metadata && msg.metadata.is_visually_hidden_from_conversation) continue;
      if (msg.recipient && msg.recipient !== 'all') continue;

      const rawText = messageText(msg);
      const text = cleanText(rawText);
      if (!text) continue;

      html += '<div class="msg msg-' + escapeHtml(role) + '">';
      html += '<div class="msg-role">' + escapeHtml(role) + '</div>';
      html += '<div class="msg-content">' + renderText(text) + '</div>';
      html += '</div>';
    }

    if (filesByFolder.length > 0) {
      html += '<div class="conv-files">';
      html += '<div class="conv-files-label">Attached files (' + conv.files.length + ')</div>';
      html += '<div class="conv-files-list">';
      conv.files.forEach((f, i) => {
        const url = filesByFolder[i];
        if (isImage(f)) {
          html += '<img class="zoomable" data-full="' + url + '" src="' + url + '" alt="' + escapeHtml(f) + '" title="' + escapeHtml(f) + '">';
        } else {
          html += '<a class="file-link" href="' + url + '" target="_blank">📎 ' + escapeHtml(f) + '</a>';
        }
      });
      html += '</div></div>';
    }

    messagesEl.innerHTML = html;
    messagesEl.scrollTop = 0;
  }

  let active = null;

  function renderSidebar(filter) {
    convListEl.innerHTML = '';
    filter = (filter || '').toLowerCase();
    let shown = 0;
    for (const project of data) {
      const matched = project.conversations.filter(c => !filter || c.title.toLowerCase().includes(filter));
      if (matched.length === 0) continue;
      const projDiv = document.createElement('div');
      projDiv.className = 'project';
      projDiv.innerHTML = '<div class="project-name"><span>' + escapeHtml(project.name) + '</span><span class="count">' + matched.length + '</span></div>';
      for (const conv of matched) {
        const div = document.createElement('div');
        div.className = 'conv-item';
        const badge = conv.files && conv.files.length > 0 ? '<span class="badge">' + conv.files.length + '</span>' : '';
        div.innerHTML = badge + escapeHtml(conv.title);
        div.title = conv.title;
        div.addEventListener('click', () => {
          document.querySelectorAll('.conv-item.active').forEach(el => el.classList.remove('active'));
          div.classList.add('active');
          active = { project: project.name, conv };
          renderConversation(project.name, conv);
        });
        projDiv.appendChild(div);
        shown++;
      }
      convListEl.appendChild(projDiv);
    }
    if (shown === 0) {
      convListEl.innerHTML = '<div style="padding:16px;color:#6f6f6f;font-size:13px">No matches.</div>';
    }
  }

  searchInput.addEventListener('input', () => renderSidebar(searchInput.value));
  renderSidebar();

  // Lightbox
  const lb = document.getElementById('lightbox');
  const lbImg = document.getElementById('lightboxImg');
  const lbClose = document.getElementById('lightboxClose');
  function openLightbox(src) { lbImg.src = src; lb.classList.add('open'); }
  function closeLightbox() { lb.classList.remove('open'); lbImg.src = ''; }
  document.addEventListener('click', e => {
    const img = e.target.closest('img.zoomable');
    if (img) { e.preventDefault(); openLightbox(img.dataset.full || img.src); }
  });
  lbClose.addEventListener('click', closeLightbox);
  lb.addEventListener('click', e => { if (e.target === lb) closeLightbox(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox(); });
})();
</script>
</body>
</html>
`;

const outPath = path.join(root, 'viewer.html');
fs.writeFileSync(outPath, html);
console.log(`Wrote ${outPath}`);
console.log(`Open it in your browser: file://${outPath}`);
