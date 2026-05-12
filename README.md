# ChatGPT Export

**Bulk export all your ChatGPT conversations** — including Team/Business workspaces, **Projects** (gizmos), attachments, and a self-contained HTML viewer.

OpenAI's built-in export only works for personal accounts. This toolkit handles workspace accounts and conversations stored inside Projects, where the official `/data` export doesn't go.

## What it does

- Exports **all conversations** — Team/Business workspaces, archived chats, and conversations inside **Projects** (gizmos)
- Saves progress incrementally to **IndexedDB** so you can stop and resume mid-run
- Handles **rate limiting** — retries 429s indefinitely with exponential backoff (caps at 2 minutes per retry)
- Captures **attachment references** in the JSON; a separate script downloads the actual files
- Optional post-processing: split into a **folder structure** with attachments inline + a **searchable HTML viewer** that renders full markdown

## Quick start (browser console)

The fastest way — no installation:

1. Go to [chatgpt.com](https://chatgpt.com) and log in (switch to your workspace if relevant)
2. Open DevTools console (`Cmd+Option+J` / `Ctrl+Shift+J`)
3. Paste the contents of [`scripts/export.js`](scripts/export.js) and press Enter
4. Wait — a `chatgpt-export-YYYY-MM-DD.json` will download when finished

**Stop and resume:**
```js
window.stopChatGPTExport = true     // stop after current conversation; saves progress
// Re-paste the script later — it skips conversations already in IndexedDB

window.clearChatGPTExport()         // wipe the saved progress and start fresh
```

## Chrome extension

For a UI with progress bar and a stop button:

1. Clone or download this repo
2. Go to `chrome://extensions/`, enable **Developer mode**, click **Load unpacked**, select the `extension/` folder
3. Open ChatGPT, click the extension icon, hit **Export All Conversations**

The extension runs the export in a **background service worker** — closing the popup or even the ChatGPT tab does **not** stop the export. Reopen the popup any time to see progress, or hit **Stop & Save Progress** for a clean shutdown. Re-run to resume.

## Post-processing pipeline

The raw JSON contains everything, but is one ~tens-of-MB file. Optional Node scripts turn it into something more usable:

```
chatgpt-export-DATE.json                  ← initial export
        │
        ├── node scripts/split-export.js   ─→  projects/<Project>/<Title>.json
        │                                       (one JSON file per conversation)
        │
        ├── (browser) scripts/download-attachments.js
        │                                  ─→  <Project>/<Title>/<files…>
        │                                       (binary attachments per conversation,
        │                                        resumable, tracks permanent failures)
        │
        ├── node scripts/merge-export.js   ─→  <Project>/<Title>/{conversation.json, files…}
        │                                       (combines split + attachments
        │                                        into one folder per conversation)
        │
        ├── node scripts/build-viewer.js   ─→  viewer.html  (single self-contained
        │                                       HTML, full markdown, image lightbox,
        │                                       sidebar with search)
        │
        └── node scripts/verify-export.js  ─→  sanity check: counts, parse errors,
                                                missing fields, orphan conversations
```

### Splitting into folders

```bash
node scripts/split-export.js chatgpt-export-2026-05-12.json
# → ./chatgpt-export-2026-05-12/projects/<Project>/<Title>_<id-suffix>.json
```

### Downloading attachments

Attachment file IDs are in the JSON, but the binaries are stored on ChatGPT's servers and need to be fetched while logged in. Open ChatGPT, then paste [`scripts/download-attachments.js`](scripts/download-attachments.js) into the console. A green **Start** button appears top-right of the page; click it, pick the export JSON, pick an output folder.

- Uses the File System Access API to write directly into the folder you choose (no 494 separate Chrome download prompts)
- **Resumable** — skips already-downloaded files on disk
- **Tracks permanent failures** in `_failed-attachments.json`. Files that ChatGPT has expired (HTTP 403 / `file_not_found`) are unrecoverable and won't be retried on subsequent runs unless you opt in via `window.retryFailedAttachments = true`
- Stop with `window.stopAttachmentDownload = true`

### Merging into per-conversation folders

```bash
node scripts/merge-export.js \
  chatgpt-export-2026-05-12.json \
  ./chatgpt-export-2026-05-12/attachments \
  ./chatgpt-export-2026-05-12-merged
```

Result:
```
<merged>/
  <Project Name>/
    <Conversation Title>/
      conversation.json
      <attachment files...>
  export-metadata.json
```

### HTML viewer

```bash
npm install marked
node scripts/build-viewer.js ./chatgpt-export-2026-05-12-merged
# → opens viewer.html in your browser
```

The viewer is a single self-contained HTML file (~25 MB for ~450 conversations) with embedded conversation data. It works fully offline (`file://`) and includes:

- Sidebar grouped by project, sorted by most recently updated
- Real-time search by title
- Full markdown rendering via `marked` (tables, code blocks, headers, lists, blockquotes…)
- Strips ChatGPT's internal citation/scaffolding markers (PUA characters, `citeturn…`, `<PARSED TEXT…>`)
- Hides system/tool messages and tool-call assistant messages
- Image attachments inline with click-to-zoom lightbox
- Non-image attachments as download links
- Auto-detects file extensions from magic bytes (renames extensionless `file-XYZ` to `file-XYZ.jpg`, etc.)

### Verifying

```bash
node scripts/verify-export.js ./chatgpt-export-2026-05-12-merged
```

Reports counts per project, flags parse errors, missing fields, empty conversations, and cross-checks against the original JSON's `conversation_count`.

## How it works

ChatGPT's web app uses internal `/backend-api/` endpoints that are accessible from your authenticated browser session. The exporter:

1. Gets your session token from `/api/auth/session`
2. Detects workspace accounts via the `_account` cookie
3. Paginates through `/backend-api/conversations` (offset-based)
4. Fetches the **Projects sidebar** (`/backend-api/gizmos/snorlax/sidebar`) and paginates each project's conversations via `/backend-api/gizmos/<id>/conversations?cursor=…` (cursor-based)
5. Fetches each conversation's full content from `/backend-api/conversation/<id>`
6. Saves each fetched conversation to IndexedDB as it goes (resumable)
7. At the end, packages everything into a single JSON download and clears IndexedDB

No API keys, no third-party servers — uses your existing browser session.

## FAQ

**Why can't I just use Settings → Data Controls → Export?**
That option only exists for personal accounts. Team/Business workspace accounts don't have it. Also, conversations inside Projects use a different API path that the official export doesn't traverse.

**Is this against OpenAI's terms?**
This accesses *your own* data via the same APIs ChatGPT itself uses. GDPR Article 20 (data portability) covers your right to your own data.

**How long does it take?**
Roughly 1 conversation per second baseline. With rate limits and Project conversations counted, ~15–20 minutes for 500 conversations is typical.

**What rate limits should I expect?**
ChatGPT's backend lets you pull ~200 conversations smoothly, then starts returning HTTP 429 and only releases after a **30–60 second cooldown** between requests. The exporter handles this automatically — on 429 it backs off exponentially (2s → 4s → … → 2 min cap) and retries the **same** conversation indefinitely (never skips on 429). So a large export will visibly slow down after the first ~200 conversations; just let it run. Progress is in IndexedDB the whole time, so if you need the tab/computer back, hit Stop and resume later.

**It returns 0 conversations / I'm in a Team workspace?**
The exporter automatically retries without the workspace header and also fetches from Projects. If you still see 0, your workspace admin may have disabled conversation history retention — in that case there's nothing on OpenAI's side to export.

**Some attachments fail to download?**
ChatGPT garbage-collects older attachments (typically returns `file_not_found` or HTTP 403). These are not recoverable — the script logs them to `_failed-attachments.json` and skips them on subsequent runs.

**The popup closes when I click away — does the export stop?**
No. With the extension, all export logic runs in the background service worker. Closing the popup, or even the ChatGPT tab, does not stop it. Reopen the popup to see progress or to stop cleanly.

## License

MIT — do whatever you want with it.
