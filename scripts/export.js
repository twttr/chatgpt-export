/**
 * ChatGPT Workspace Exporter
 *
 * Bulk exports all conversations from ChatGPT, including Team/Business workspaces
 * and Projects (gizmos), where OpenAI doesn't provide a native export option.
 *
 * Progress is saved to IndexedDB after every conversation — safe to stop and resume.
 *
 * Usage:     Paste into browser console while logged into chatgpt.com
 * Stop:      window.stopChatGPTExport = true
 * Resume:    Run the script again — it picks up where it left off
 * Start fresh: window.clearChatGPTExport()  then re-run
 *
 * MIT License - https://github.com/twttr/chatgpt-export
 */

(async function ChatGPTExport() {
  'use strict';

  const CONFIG = {
    BASE_URL: 'https://chatgpt.com/backend-api',
    SESSION_URL: 'https://chatgpt.com/api/auth/session',
    PAGE_SIZE: 100,
    DELAY_BETWEEN_FETCHES: 800,
    DELAY_BETWEEN_PAGES: 300,
    MAX_RETRIES: 5,
    INITIAL_BACKOFF: 2000,
    MAX_BACKOFF: 120000,
    DB_NAME: 'chatgpt-export',
    DB_VERSION: 1,
  };

  window.stopChatGPTExport = false;
  window.clearChatGPTExport = async function () {
    const db = await openDB();
    await dbClear(db, 'conversations');
    await dbClear(db, 'meta');
    db.close();
    console.log('[ChatGPT Export] Cleared. Next run will start fresh.');
  };

  // ── Helpers ──────────────────────────────────────────────

  function log(msg) { console.log(`[ChatGPT Export] ${msg}`); }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function getAccessToken() {
    const resp = await fetch(CONFIG.SESSION_URL, { credentials: 'include' });
    if (!resp.ok) throw new Error('Failed to get session. Are you logged in?');
    const data = await resp.json();
    if (!data.accessToken) throw new Error('No access token in session response.');
    return data.accessToken;
  }

  function getWorkspaceAccountId() {
    const cookie = document.cookie.split(';').find(c => c.trim().startsWith('_account='));
    return cookie ? cookie.split('=')[1].trim() : null;
  }

  function buildHeaders(token, accountId) {
    const h = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
    if (accountId) h['Chatgpt-Account-Id'] = accountId;
    return h;
  }

  async function fetchWithRetry(url, headers) {
    let delay = CONFIG.INITIAL_BACKOFF;
    let attempt = 0;
    while (true) {
      const resp = await fetch(url, { headers, credentials: 'include' });
      if (resp.ok) return resp;
      if (resp.status === 429) {
        const wait = parseInt(resp.headers.get('retry-after') || '0') * 1000 || delay;
        log('Rate limited. Waiting ' + Math.round(wait / 1000) + 's (attempt ' + (attempt + 1) + ')');
        await sleep(wait);
        delay = Math.min(delay * 2, CONFIG.MAX_BACKOFF);
        attempt++;
      } else {
        throw new Error('HTTP ' + resp.status + ': ' + resp.statusText);
      }
    }
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function extractItems(data) { return data.items || data.conversations || []; }

  // ── IndexedDB ────────────────────────────────────────────

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('conversations')) {
          db.createObjectStore('conversations', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      };
      req.onsuccess = e => resolve(e.target.result);
      req.onerror = e => reject(e.target.error);
    });
  }

  function dbGet(db, store, key) {
    return new Promise((resolve, reject) => {
      const req = db.transaction(store, 'readonly').objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : undefined);
      req.onerror = () => reject(req.error);
    });
  }

  function dbPut(db, store, key, value) {
    return new Promise((resolve, reject) => {
      const req = db.transaction(store, 'readwrite').objectStore(store).put({ key, value });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  function dbPutConversation(db, conv) {
    return new Promise((resolve, reject) => {
      const req = db.transaction('conversations', 'readwrite').objectStore('conversations').put(conv);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  function dbGetAllConversations(db) {
    return new Promise((resolve, reject) => {
      const req = db.transaction('conversations', 'readonly').objectStore('conversations').getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function dbClear(db, store) {
    return new Promise((resolve, reject) => {
      const req = db.transaction(store, 'readwrite').objectStore(store).clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  // ── Fetch gizmo/project conversations ───────────────────

  async function fetchGizmoConversations(gizmoId, projectName, headers) {
    const result = [];
    let cursor = '0';
    while (true) {
      const resp = await fetchWithRetry(
        CONFIG.BASE_URL + '/gizmos/' + gizmoId + '/conversations?cursor=' + cursor,
        headers
      );
      const data = await resp.json();
      const items = extractItems(data);
      for (const item of items) {
        result.push(Object.assign({}, item, { project_name: projectName, project_id: gizmoId }));
      }
      if (!data.cursor || items.length === 0) break;
      cursor = data.cursor;
      await sleep(CONFIG.DELAY_BETWEEN_PAGES);
    }
    return result;
  }

  async function fetchProjects(headers) {
    try {
      const resp = await fetchWithRetry(CONFIG.BASE_URL + '/gizmos/snorlax/sidebar', headers);
      const data = await resp.json();
      return extractItems(data)
        .filter(item => item.gizmo && item.gizmo.id)
        .map(item => ({
          id: item.gizmo.id,
          name: (item.gizmo.display && item.gizmo.display.name) || item.gizmo.id,
        }));
    } catch (err) {
      log('Could not fetch project list: ' + err.message);
      return [];
    }
  }

  // ── Extract attachment IDs ───────────────────────────────

  function extractAttachments(conv, fullData, fileAttachments) {
    if (!fullData.mapping) return;
    for (const node of Object.values(fullData.mapping)) {
      if (node?.message?.metadata?.attachments) {
        for (const att of node.message.metadata.attachments) {
          if (att.id && !fileAttachments[att.id]) {
            fileAttachments[att.id] = { name: att.name || att.id, conversationId: conv.id, conversationTitle: conv.title };
          }
        }
      }
      if (node?.message?.content?.parts) {
        for (const part of node.message.content.parts) {
          if (part && typeof part === 'object' && part.asset_pointer?.startsWith('file-service://')) {
            const fid = part.asset_pointer.replace('file-service://', '');
            if (!fileAttachments[fid]) {
              fileAttachments[fid] = { name: fid, conversationId: conv.id, conversationTitle: conv.title };
            }
          }
        }
      }
    }
  }

  // ── Main Export ──────────────────────────────────────────

  log('Starting export...');
  log('Stop and save progress at any time: window.stopChatGPTExport = true');

  const db = await openDB();

  // Step 1: Auth
  log('Getting access token...');
  const token = await getAccessToken();
  const accountId = getWorkspaceAccountId();
  let headers = buildHeaders(token, accountId);
  log('Authenticated.' + (accountId ? ' Workspace: ' + accountId : ' Personal account.'));

  // Step 2: Load or build conversation list
  let allConversations = await dbGet(db, 'meta', 'allConversations');

  if (allConversations && allConversations.length > 0) {
    const alreadyDone = await dbGetAllConversations(db);
    log('Resuming: ' + alreadyDone.length + '/' + allConversations.length + ' already fetched. ' +
        (allConversations.length - alreadyDone.length) + ' remaining.');
    log('To start fresh: window.clearChatGPTExport()  then re-run.');
  } else {
    log('Fetching conversation list...');
    allConversations = [];
    let offset = 0;

    while (true) {
      const resp = await fetchWithRetry(
        CONFIG.BASE_URL + '/conversations?offset=' + offset + '&limit=' + CONFIG.PAGE_SIZE,
        headers
      );
      const data = await resp.json();
      const items = extractItems(data);
      allConversations.push(...items);
      log('Listed ' + allConversations.length + ' conversations...');
      if (items.length < CONFIG.PAGE_SIZE) break;
      offset += CONFIG.PAGE_SIZE;
      await sleep(CONFIG.DELAY_BETWEEN_PAGES);
    }

    if (allConversations.length === 0 && accountId) {
      log('No conversations with workspace header. Retrying without...');
      headers = buildHeaders(token, null);
      offset = 0;
      while (true) {
        const resp = await fetchWithRetry(
          CONFIG.BASE_URL + '/conversations?offset=' + offset + '&limit=' + CONFIG.PAGE_SIZE,
          headers
        );
        const data = await resp.json();
        const items = extractItems(data);
        allConversations.push(...items);
        log('Listed ' + allConversations.length + ' conversations...');
        if (items.length < CONFIG.PAGE_SIZE) break;
        offset += CONFIG.PAGE_SIZE;
        await sleep(CONFIG.DELAY_BETWEEN_PAGES);
      }
    }

    log('Checking for archived conversations...');
    const archData = await (await fetchWithRetry(
      CONFIG.BASE_URL + '/conversations?offset=0&limit=' + CONFIG.PAGE_SIZE + '&is_archived=true',
      headers
    )).json();
    const archItems = extractItems(archData);
    if (archItems.length > 0) {
      allConversations.push(...archItems);
      log('Found ' + archItems.length + ' archived conversations.');
    }

    log('Fetching Projects list...');
    const projects = await fetchProjects(headers);
    log('Found ' + projects.length + ' project(s).');
    const seenIds = new Set(allConversations.map(c => c.id));
    for (const project of projects) {
      log('Fetching project: ' + project.name + '...');
      const projConvs = await fetchGizmoConversations(project.id, project.name, headers);
      let added = 0;
      for (const c of projConvs) {
        if (!seenIds.has(c.id)) { allConversations.push(c); seenIds.add(c.id); added++; }
      }
      log('  ' + added + ' new from "' + project.name + '".');
      await sleep(CONFIG.DELAY_BETWEEN_PAGES);
    }

    await dbPut(db, 'meta', 'allConversations', allConversations);
    log('Conversation list saved (' + allConversations.length + ' total).');
  }

  log('Total: ' + allConversations.length + ' conversations to export.');

  // Step 3: Fetch full content — skip any already saved in IndexedDB
  const alreadyFetched = new Map(
    (await dbGetAllConversations(db)).map(c => [c.id, c])
  );
  log(alreadyFetched.size + ' conversations already in local storage, skipping those.');

  const fileAttachments = {};
  const errors = [];
  let fetched = 0;
  let stopped = false;

  for (let i = 0; i < allConversations.length; i++) {
    const conv = allConversations[i];

    if (alreadyFetched.has(conv.id)) continue;

    if (window.stopChatGPTExport) {
      log('Stop requested. Progress saved — re-run the script to continue.');
      stopped = true;
      break;
    }

    try {
      const resp = await fetchWithRetry(CONFIG.BASE_URL + '/conversation/' + conv.id, headers);
      const fullData = await resp.json();

      const record = {
        id: conv.id,
        title: conv.title,
        create_time: conv.create_time,
        update_time: conv.update_time,
        project_id: conv.project_id || null,
        project_name: conv.project_name || null,
        conversation: fullData,
      };

      await dbPutConversation(db, record);
      alreadyFetched.set(conv.id, record);
      fetched++;

      log('(' + (alreadyFetched.size) + '/' + allConversations.length + ') ' + (conv.title || 'Untitled'));
    } catch (err) {
      log('ERROR: ' + (conv.title || conv.id) + ' — ' + err.message);
      errors.push({ id: conv.id, title: conv.title, error: err.message });
    }

    await sleep(CONFIG.DELAY_BETWEEN_FETCHES);
  }

  // Step 4: Build and download export from IndexedDB (includes all sessions)
  if (!stopped) {
    log('Building export file...');
    const allFetched = await dbGetAllConversations(db);
    for (const conv of allFetched) {
      if (conv.conversation) extractAttachments(conv, conv.conversation, fileAttachments);
    }

    const exportData = {
      export_time: new Date().toISOString(),
      source: 'chatgpt-export (github.com/twttr/chatgpt-export)',
      workspace_account_id: accountId || null,
      conversation_count: allFetched.length,
      attachment_count: Object.keys(fileAttachments).length,
      errors,
      attachments: fileAttachments,
      conversations: allFetched,
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const filename = 'chatgpt-export-' + new Date().toISOString().slice(0, 10) + '.json';
    triggerDownload(blob, filename);

    const sizeMB = Math.round(blob.size / 1024 / 1024);
    log('Done! Exported ' + allFetched.length + ' conversations (~' + sizeMB + ' MB) as ' + filename);
    log(Object.keys(fileAttachments).length + ' attachment references found.');
    if (errors.length > 0) log(errors.length + ' errors (see export file for details).');

    log('Clearing local storage...');
    await dbClear(db, 'conversations');
    await dbClear(db, 'meta');
  } else {
    log('Stopped. ' + fetched + ' new conversations saved this session.');
    log('Re-run the script to continue from where you left off.');
  }

  db.close();

  return { fetched, errors: errors.length, stopped };
})();
