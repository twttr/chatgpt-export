/**
 * ChatGPT Export - Background Service Worker
 * Runs independently of the popup. Export continues even when popup is closed.
 *
 * Logic:
 *   1. Fetch full conversation list fresh each run
 *   2. Fetch each conversation's content, skipping ones already saved in IndexedDB
 *   3. On resume, step 1 runs again (catches new conversations too), step 2 skips done ones
 */

'use strict';

const CONFIG = {
  BASE_URL: 'https://chatgpt.com/backend-api',
  PAGE_SIZE: 100,
  DELAY_BETWEEN_FETCHES: 800,
  DELAY_BETWEEN_PAGES: 300,
  MAX_RETRIES: 5,
  INITIAL_BACKOFF: 2000,
  MAX_BACKOFF: 120000,
  DB_NAME: 'chatgpt-export',
  DB_VERSION: 1,
};

let stopRequested = false;

// ── Keep service worker alive ────────────────────────────

chrome.alarms.onAlarm.addListener(() => {});

function startKeepAlive() {
  chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
}

function stopKeepAlive() {
  chrome.alarms.clear('keepAlive');
}

// ── Broadcast to popup (silent if popup is closed) ───────

function broadcast(type, data) {
  chrome.runtime.sendMessage(Object.assign({ type }, data)).catch(() => {});
}

// ── IndexedDB ────────────────────────────────────────────

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('conversations')) {
        db.createObjectStore('conversations', { keyPath: 'id' });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

function dbPut(db, conv) {
  return new Promise((resolve, reject) => {
    const req = db.transaction('conversations', 'readwrite').objectStore('conversations').put(conv);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function dbGetAllIds(db) {
  return new Promise((resolve, reject) => {
    const req = db.transaction('conversations', 'readonly').objectStore('conversations').getAllKeys();
    req.onsuccess = () => resolve(new Set(req.result));
    req.onerror = () => reject(req.error);
  });
}

function dbGetAll(db) {
  return new Promise((resolve, reject) => {
    const req = db.transaction('conversations', 'readonly').objectStore('conversations').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbClear(db) {
  return new Promise((resolve, reject) => {
    const req = db.transaction('conversations', 'readwrite').objectStore('conversations').clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ── Helpers ──────────────────────────────────────────────

function log(msg) {
  console.log('[ChatGPT Export] ' + msg);
  broadcast('export-log', { text: msg });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
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
    const resp = await fetch(url, { headers });
    if (resp.ok) return resp;
    if (resp.status === 429) {
      const wait = parseInt(resp.headers.get('retry-after') || '0') * 1000 || delay;
      log('Rate limited. Waiting ' + Math.round(wait / 1000) + 's (attempt ' + (attempt + 1) + ')');
      broadcast('export-status', { text: 'Rate limited, waiting ' + Math.round(wait / 1000) + 's...' });
      await sleep(wait);
      delay = Math.min(delay * 2, CONFIG.MAX_BACKOFF);
      attempt++;
    } else {
      throw new Error('HTTP ' + resp.status + ': ' + resp.statusText);
    }
  }
}

function extractItems(data) {
  return data.items || data.conversations || [];
}

// ── Fetch conversation list ──────────────────────────────

async function fetchConversationList(headers, options) {
  const all = [];

  let offset = 0;
  while (true) {
    const resp = await fetchWithRetry(
      CONFIG.BASE_URL + '/conversations?offset=' + offset + '&limit=' + CONFIG.PAGE_SIZE,
      headers
    );
    const data = await resp.json();
    const items = extractItems(data);
    all.push(...items);
    broadcast('export-stats', { conversations: all.length });
    if (items.length < CONFIG.PAGE_SIZE) break;
    offset += CONFIG.PAGE_SIZE;
    await sleep(CONFIG.DELAY_BETWEEN_PAGES);
  }

  if (options.includeArchived) {
    const data = await (await fetchWithRetry(
      CONFIG.BASE_URL + '/conversations?offset=0&limit=' + CONFIG.PAGE_SIZE + '&is_archived=true',
      headers
    )).json();
    const items = extractItems(data);
    if (items.length > 0) {
      all.push(...items);
      log('Found ' + items.length + ' archived conversations.');
    }
  }

  // Projects (gizmos with cursor-based pagination)
  try {
    const sidebarData = await (await fetchWithRetry(
      CONFIG.BASE_URL + '/gizmos/snorlax/sidebar', headers
    )).json();
    const projects = extractItems(sidebarData)
      .filter(item => item.gizmo && item.gizmo.id)
      .map(item => ({
        id: item.gizmo.id,
        name: (item.gizmo.display && item.gizmo.display.name) || item.gizmo.id,
      }));

    log('Found ' + projects.length + ' project(s).');
    const seenIds = new Set(all.map(c => c.id));

    for (const project of projects) {
      let cursor = '0';
      let added = 0;
      while (true) {
        const data = await (await fetchWithRetry(
          CONFIG.BASE_URL + '/gizmos/' + project.id + '/conversations?cursor=' + cursor,
          headers
        )).json();
        const items = extractItems(data);
        for (const item of items) {
          if (!seenIds.has(item.id)) {
            all.push(Object.assign({}, item, { project_name: project.name, project_id: project.id }));
            seenIds.add(item.id);
            added++;
          }
        }
        if (!data.cursor || items.length === 0) break;
        cursor = data.cursor;
        await sleep(CONFIG.DELAY_BETWEEN_PAGES);
      }
      log('Project "' + project.name + '": ' + added + ' conversations.');
      broadcast('export-stats', { conversations: all.length });
    }
  } catch (err) {
    log('Could not fetch projects: ' + err.message);
  }

  return all;
}

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
        if (part?.asset_pointer?.startsWith('file-service://')) {
          const fid = part.asset_pointer.replace('file-service://', '');
          if (!fileAttachments[fid]) {
            fileAttachments[fid] = { name: fid, conversationId: conv.id, conversationTitle: conv.title };
          }
        }
      }
    }
  }
}

async function getAuth() {
  const resp = await fetch('https://chatgpt.com/api/auth/session', { credentials: 'include' });
  if (!resp.ok) throw new Error('Failed to get session. Are you logged in to ChatGPT?');
  const data = await resp.json();
  if (!data.accessToken) throw new Error('No access token. Are you logged in to ChatGPT?');
  const accountCookie = await chrome.cookies.get({ url: 'https://chatgpt.com', name: '_account' });
  return {
    token: data.accessToken,
    accountId: accountCookie ? accountCookie.value : null,
  };
}

// ── Main Export ──────────────────────────────────────────

async function runExport(options) {
  stopRequested = false;
  startKeepAlive();

  const db = await openDB();

  try {
    broadcast('export-status', { text: 'Authenticating...' });
    const { token, accountId } = await getAuth();
    let headers = buildHeaders(token, accountId);
    log('Authenticated.' + (accountId ? ' Workspace: ' + accountId : ' Personal account.'));

    // Step 1: fetch full conversation list (always fresh)
    broadcast('export-status', { text: 'Listing conversations...' });
    log('Fetching conversation list...');

    let allConversations = await fetchConversationList(headers, options);

    if (allConversations.length === 0 && accountId) {
      log('No conversations with workspace header. Retrying without...');
      headers = buildHeaders(token, null);
      allConversations = await fetchConversationList(headers, options);
    }

    log('Total: ' + allConversations.length + ' conversations found.');
    broadcast('export-stats', { conversations: allConversations.length });

    // Step 2: fetch content for each, skipping already saved ones
    broadcast('export-status', { text: 'Downloading...' });
    const doneIds = await dbGetAllIds(db);
    const remaining = allConversations.filter(c => !doneIds.has(c.id));
    log(doneIds.size + ' already saved, ' + remaining.length + ' to fetch.');

    const errors = [];

    for (let i = 0; i < remaining.length; i++) {
      const conv = remaining[i];

      if (stopRequested) {
        const saved = doneIds.size + i;
        log('Stopped. ' + saved + '/' + allConversations.length + ' saved. Re-run to continue.');
        broadcast('export-status', { text: 'Stopped' });
        broadcast('export-stopped', { saved, total: allConversations.length });
        stopKeepAlive();
        db.close();
        return;
      }

      try {
        const resp = await fetchWithRetry(CONFIG.BASE_URL + '/conversation/' + conv.id, headers);
        const fullData = await resp.json();

        await dbPut(db, {
          id: conv.id,
          title: conv.title,
          create_time: conv.create_time,
          update_time: conv.update_time,
          project_id: conv.project_id || null,
          project_name: conv.project_name || null,
          conversation: fullData,
        });

        doneIds.add(conv.id);
        broadcast('export-progress', { current: doneIds.size, total: allConversations.length });
        log('(' + doneIds.size + '/' + allConversations.length + ') ' + (conv.title || 'Untitled'));
      } catch (err) {
        log('ERROR: ' + (conv.title || conv.id) + ' — ' + err.message);
        errors.push({ id: conv.id, title: conv.title, error: err.message });
      }

      await sleep(CONFIG.DELAY_BETWEEN_FETCHES);
    }

    // Step 3: build and download export from DB
    broadcast('export-status', { text: 'Packaging...' });
    log('Building export file...');

    const allFetched = await dbGetAll(db);
    const fileAttachments = {};
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

    const jsonStr = JSON.stringify(exportData, null, 2);
    const bytes = new TextEncoder().encode(jsonStr);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    const dataUrl = 'data:application/json;base64,' + btoa(binary);
    const filename = 'chatgpt-export-' + new Date().toISOString().slice(0, 10) + '.json';
    await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });

    log('Done! Exported ' + allFetched.length + ' conversations as ' + filename);

    // Download file attachments
    if (options.includeAttachments && Object.keys(fileAttachments).length > 0) {
      broadcast('export-status', { text: 'Downloading attachments...' });
      const fileIds = Object.keys(fileAttachments);
      log('Downloading ' + fileIds.length + ' attachments...');
      let downloaded = 0;
      let attachErrors = 0;

      for (const fid of fileIds) {
        const fname = fileAttachments[fid].name || fid;
        try {
          const resp = await fetchWithRetry(CONFIG.BASE_URL + '/files/' + fid + '/download', headers);
          const ct = resp.headers.get('content-type') || '';
          if (ct.includes('application/json')) {
            const jdata = await resp.json();
            if (jdata.download_url) {
              await chrome.downloads.download({ url: jdata.download_url, filename: fname, saveAs: false });
              downloaded++;
            }
          } else {
            const blob = await resp.blob();
            const bytes = new Uint8Array(await blob.arrayBuffer());
            let binary = '';
            for (let i = 0; i < bytes.length; i += 8192) {
              binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
            }
            const dataUrl = 'data:' + (ct || 'application/octet-stream') + ';base64,' + btoa(binary);
            await chrome.downloads.download({ url: dataUrl, filename: fname, saveAs: false });
            downloaded++;
          }
        } catch (err) {
          log('Attachment error: ' + fname + ' — ' + err.message);
          attachErrors++;
        }
        await sleep(CONFIG.DELAY_BETWEEN_FETCHES);
      }

      log('Attachments: ' + downloaded + ' downloaded, ' + attachErrors + ' failed.');
      broadcast('export-stats', { attachments: downloaded });
    }

    broadcast('export-done', { conversations: allFetched.length, attachments: Object.keys(fileAttachments).length });

    await dbClear(db);

  } catch (err) {
    log('Export failed: ' + err.message);
    broadcast('export-error', { text: err.message });
  } finally {
    stopKeepAlive();
    db.close();
  }
}

// ── Message handler ──────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'startExport') {
    runExport(msg.options || {});
    sendResponse({ started: true });
  }
  if (msg.action === 'stopExport') {
    stopRequested = true;
    sendResponse({ stopping: true });
  }
  if (msg.action === 'getStatus') {
    openDB().then(async db => {
      const saved = (await dbGetAllIds(db)).size;
      db.close();
      sendResponse({ hasSavedProgress: saved > 0, saved });
    });
    return true;
  }
  if (msg.action === 'clearProgress') {
    openDB().then(async db => {
      await dbClear(db);
      db.close();
      sendResponse({ cleared: true });
    });
    return true;
  }
});
