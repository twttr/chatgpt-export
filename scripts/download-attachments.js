/**
 * Download Attachments from a ChatGPT Export JSON
 *
 * Reads an existing chatgpt-export-*.json and downloads every referenced
 * attachment into a folder structure:
 *
 *   <chosen-dir>/
 *     <Project Name>/
 *       <Conversation Title>/
 *         <attachment files>
 *
 * Resumable: skips files that already exist on disk.
 *
 * Usage: Paste into browser console while logged into chatgpt.com (Chrome/Edge),
 *        then click the green "Start" button that appears in the top-right.
 */

(function () {
  'use strict';

  if (!window.showDirectoryPicker) {
    console.error('[Attach] Browser does not support File System Access. Use Chrome or Edge.');
    return;
  }

  const DELAY = 500;

  function log(msg) { console.log('[Attach] ' + msg); }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function sanitize(s) {
    if (!s) return 'untitled';
    return s.replace(/[\/\\:*?"<>|\n\r\t]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100) || 'untitled';
  }

  async function fetchWithRetry(url, headers) {
    let delay = 2000;
    let attempt = 0;
    while (true) {
      const resp = await fetch(url, { headers, credentials: 'include' });
      if (resp.ok) return resp;
      if (resp.status === 429) {
        const wait = parseInt(resp.headers.get('retry-after') || '0') * 1000 || delay;
        log('Rate limited. Waiting ' + Math.round(wait / 1000) + 's (attempt ' + (attempt + 1) + ')');
        await sleep(wait);
        delay = Math.min(delay * 2, 120000);
        attempt++;
      } else {
        throw new Error('HTTP ' + resp.status);
      }
    }
  }

  async function run() {
    let rootDir, jsonFile;

    // 1) Directory picker — within the button click handler for user activation
    try {
      rootDir = await window.showDirectoryPicker({ mode: 'readwrite' });
    } catch (e) {
      log('No directory selected.');
      return;
    }

    // 2) File picker — fileInput.click() works programmatically after an awaited gesture
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'application/json';
    jsonFile = await new Promise(resolve => {
      fileInput.onchange = () => resolve(fileInput.files[0] || null);
      fileInput.oncancel = () => resolve(null);
      fileInput.click();
    });
    if (!jsonFile) { log('No file selected.'); return; }

    // 3) Parse
    log('Reading ' + jsonFile.name + '...');
    const data = JSON.parse(await jsonFile.text());
    const attIds = Object.keys(data.attachments || {});
    log('Found ' + attIds.length + ' attachments, ' + (data.conversations || []).length + ' conversations.');

    // 4) Auth
    const sessionResp = await fetch('https://chatgpt.com/api/auth/session', { credentials: 'include' });
    if (!sessionResp.ok) { log('Not logged in to chatgpt.com.'); return; }
    const { accessToken: token } = await sessionResp.json();
    if (!token) { log('No access token. Are you logged in?'); return; }
    const accountCookie = document.cookie.split(';').find(c => c.trim().startsWith('_account='));
    const accountId = accountCookie ? accountCookie.split('=')[1].trim() : null;
    const headers = accountId
      ? { 'Authorization': 'Bearer ' + token, 'Chatgpt-Account-Id': accountId }
      : { 'Authorization': 'Bearer ' + token };

    const convById = Object.fromEntries((data.conversations || []).map(c => [c.id, c]));

    async function dir(parent, name) { return parent.getDirectoryHandle(sanitize(name), { create: true }); }
    async function exists(d, name) {
      try { await d.getFileHandle(sanitize(name)); return true; } catch { return false; }
    }
    async function write(d, name, blob) {
      const fh = await d.getFileHandle(sanitize(name), { create: true });
      const w = await fh.createWritable();
      await w.write(blob);
      await w.close();
    }

    const FAILED_FILE = '_failed-attachments.json';
    async function loadFailed() {
      try {
        const fh = await rootDir.getFileHandle(FAILED_FILE);
        const f = await fh.getFile();
        return new Set(JSON.parse(await f.text()));
      } catch { return new Set(); }
    }
    async function saveFailed(set) {
      const fh = await rootDir.getFileHandle(FAILED_FILE, { create: true });
      const w = await fh.createWritable();
      await w.write(JSON.stringify([...set], null, 2));
      await w.close();
    }

    const previouslyFailed = await loadFailed();
    if (previouslyFailed.size > 0 && !window.retryFailedAttachments) {
      log(previouslyFailed.size + ' previously-failed attachments will be skipped. ' +
          'To retry them: set window.retryFailedAttachments = true and re-run.');
    } else if (window.retryFailedAttachments) {
      log('Retrying previously-failed attachments (window.retryFailedAttachments=true).');
      previouslyFailed.clear();
    }

    window.stopAttachmentDownload = false;
    log('Stop anytime: window.stopAttachmentDownload = true');

    let done = 0, skipped = 0, failed = 0, skippedFailed = 0;

    for (let i = 0; i < attIds.length; i++) {
      if (window.stopAttachmentDownload) { log('Stopped.'); break; }

      const fid = attIds[i];
      const att = data.attachments[fid];
      const conv = convById[att.conversationId];
      const projName = (conv && conv.project_name) ? conv.project_name : 'no-project';
      const convTitle = att.conversationTitle || (conv && conv.title) || att.conversationId || 'unknown';

      if (previouslyFailed.has(fid)) {
        skippedFailed++;
        continue;
      }

      try {
        const projDir = await dir(rootDir, projName);
        const convDir = await dir(projDir, convTitle);

        if (await exists(convDir, att.name)) {
          skipped++;
          log('(' + (i + 1) + '/' + attIds.length + ') skip (exists): ' + att.name);
          continue;
        }

        const resp = await fetchWithRetry('https://chatgpt.com/backend-api/files/' + fid + '/download', headers);
        const ct = resp.headers.get('content-type') || '';

        let blob;
        if (ct.includes('application/json')) {
          const meta = await resp.json();
          const url = meta.download_url || meta.url || meta.signed_url || (meta.file && meta.file.download_url);
          if (!url) {
            const reason = meta.error_code || meta.error_type || meta.status || 'unknown';
            throw new Error(reason);
          }
          const dlResp = await fetch(url);
          if (!dlResp.ok) throw new Error('CDN HTTP ' + dlResp.status);
          blob = await dlResp.blob();
        } else {
          blob = await resp.blob();
        }

        await write(convDir, att.name, blob);
        done++;
        log('(' + (i + 1) + '/' + attIds.length + ') ' + att.name);
      } catch (err) {
        failed++;
        previouslyFailed.add(fid);
        log('(' + (i + 1) + '/' + attIds.length + ') FAIL: ' + att.name + ' — ' + err.message);
        if (failed % 10 === 0) await saveFailed(previouslyFailed);
      }

      await sleep(DELAY);
    }

    await saveFailed(previouslyFailed);
    log('Done. ' + done + ' downloaded, ' + skipped + ' skipped (exist), ' +
        skippedFailed + ' skipped (previously failed), ' + failed + ' failed.');
    log('Failed IDs saved to ' + FAILED_FILE + ' in the output directory.');
  }

  // Inject Start button — provides fresh user activation for showDirectoryPicker
  const existing = document.getElementById('__chatgpt_attach_btn');
  if (existing) existing.remove();
  const btn = document.createElement('button');
  btn.id = '__chatgpt_attach_btn';
  btn.textContent = 'Start Attachment Download';
  btn.style.cssText =
    'position:fixed;top:16px;right:16px;z-index:2147483647;' +
    'padding:12px 18px;background:#10b981;color:#fff;border:none;' +
    'border-radius:8px;cursor:pointer;font:600 14px -apple-system,Segoe UI,sans-serif;' +
    'box-shadow:0 4px 12px rgba(0,0,0,0.3);';
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = 'Working...';
    try { await run(); }
    catch (e) { log('Error: ' + e.message); }
    finally { btn.remove(); }
  };
  document.body.appendChild(btn);
  log('Click the green "Start Attachment Download" button in the top-right of the page.');
})();
