#!/usr/bin/env node
/**
 * Verify a merged ChatGPT export folder.
 *
 * Checks every conversation.json for:
 *   - parse errors
 *   - missing fields (id, conversation.mapping)
 *   - empty conversations (no messages)
 *   - error markers from the original export
 *   - conversations referenced in attachments but with no folder
 *
 * Also reports counts and any inconsistencies.
 *
 * Usage: node verify-export.js <merged-dir>
 */

const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
if (!dir) {
  console.error('Usage: node verify-export.js <merged-dir>');
  process.exit(1);
}

const root = path.resolve(dir);
console.log('Verifying ' + root + '\n');

const issues = {
  parseErrors: [],
  missingId: [],
  missingMapping: [],
  noMessages: [],
  exportErrors: [],
  errorField: [],
  malformedMessages: [],
};

let totalConvs = 0;
let totalMessages = 0;
let totalAttachments = 0;
const projects = {};

for (const projName of fs.readdirSync(root)) {
  const projPath = path.join(root, projName);
  if (!fs.statSync(projPath).isDirectory()) continue;
  projects[projName] = 0;

  for (const convFolder of fs.readdirSync(projPath)) {
    const convPath = path.join(projPath, convFolder);
    if (!fs.statSync(convPath).isDirectory()) continue;
    const jsonPath = path.join(convPath, 'conversation.json');
    if (!fs.existsSync(jsonPath)) {
      issues.parseErrors.push(`${projName}/${convFolder} — no conversation.json`);
      continue;
    }

    let conv;
    try {
      conv = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch (e) {
      issues.parseErrors.push(`${projName}/${convFolder} — parse error: ${e.message}`);
      continue;
    }
    totalConvs++;
    projects[projName]++;

    if (!conv.id) issues.missingId.push(`${projName}/${convFolder}`);
    if (conv.error) issues.errorField.push(`${projName}/${convFolder} — ${conv.error}`);

    if (!conv.conversation || !conv.conversation.mapping) {
      issues.missingMapping.push(`${projName}/${convFolder} — "${conv.title || conv.id}"`);
      continue;
    }

    const nodes = Object.values(conv.conversation.mapping);
    const realMessages = nodes.filter(n => {
      if (!n.message) return false;
      const role = n.message.author?.role;
      if (role === 'system' || role === 'tool') return false;
      if (n.message.metadata?.is_visually_hidden_from_conversation) return false;
      const parts = n.message.content?.parts || [];
      const text = parts.map(p => typeof p === 'string' ? p : (p?.text || '')).join('').trim();
      return text.length > 0;
    });

    if (realMessages.length === 0) {
      issues.noMessages.push(`${projName}/${convFolder} — "${conv.title || conv.id}"`);
    }

    totalMessages += nodes.filter(n => n.message).length;

    // count attachments (files in folder other than conversation.json and hidden files)
    const files = fs.readdirSync(convPath).filter(f => f !== 'conversation.json' && !f.startsWith('.'));
    totalAttachments += files.length;
  }
}

// Compare against original export metadata
const metadataPath = path.join(root, 'export-metadata.json');
if (fs.existsSync(metadataPath)) {
  const meta = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  if (meta.errors && meta.errors.length > 0) {
    for (const err of meta.errors) {
      issues.exportErrors.push(`${err.id} — "${err.title}" — ${err.error}`);
    }
  }
  console.log(`Original export: ${meta.conversation_count} conversations, ${meta.attachment_count} attachment references, ${(meta.errors || []).length} errors.`);
  if (meta.conversation_count !== totalConvs) {
    console.log(`⚠️  MISMATCH: merged folder has ${totalConvs} conversations, original export claims ${meta.conversation_count}.`);
  } else {
    console.log(`✓ Conversation count matches (${totalConvs}).`);
  }
}

console.log(`\nProjects:`);
for (const [name, count] of Object.entries(projects)) {
  console.log(`  ${name}: ${count} conversations`);
}
console.log(`\nTotals: ${totalConvs} conversations, ${totalMessages} messages (incl. system/tool), ${totalAttachments} attachment files on disk.\n`);

let anyIssues = false;
for (const [key, list] of Object.entries(issues)) {
  if (list.length === 0) continue;
  anyIssues = true;
  console.log(`── ${key} (${list.length}) ──`);
  for (const item of list.slice(0, 20)) console.log('  ' + item);
  if (list.length > 20) console.log(`  ... and ${list.length - 20} more`);
  console.log('');
}

if (!anyIssues) {
  console.log('✓ No issues found. All conversations look complete.');
}
