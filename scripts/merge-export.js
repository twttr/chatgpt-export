#!/usr/bin/env node
/**
 * Merge a ChatGPT export JSON + downloaded attachments into a unified
 * folder structure where each conversation gets its own folder containing
 * both the conversation.json and its attachments.
 *
 * Output:
 *   <out-dir>/
 *     <Project Name>/
 *       <Conversation Title>/
 *         conversation.json
 *         <attachment files...>
 *     no-project/
 *       <Conversation Title>/
 *         conversation.json
 *     export-metadata.json
 *
 * Usage: node merge-export.js <export.json> <attachments-dir> [output-dir]
 */

const fs = require('fs');
const path = require('path');

function sanitize(s) {
  if (!s) return 'untitled';
  return s.replace(/[\/\\:*?"<>|\n\r\t]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100) || 'untitled';
}

const [,, input, attachDir, outArg] = process.argv;
if (!input || !attachDir) {
  console.error('Usage: node merge-export.js <export.json> <attachments-dir> [output-dir]');
  process.exit(1);
}

const inputPath = path.resolve(input);
const attachPath = path.resolve(attachDir);
const outDir = path.resolve(outArg || inputPath.replace(/\.json$/, '-merged'));

console.log(`Reading ${inputPath}...`);
const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

fs.mkdirSync(outDir, { recursive: true });

const usedPaths = new Set();
let convs = 0, attachmentsCopied = 0, convsWithAttachments = 0;

for (const conv of (data.conversations || [])) {
  const projName = conv.project_name ? sanitize(conv.project_name) : 'no-project';
  const baseTitle = sanitize(conv.title || 'untitled');
  const suffix = (conv.id || '').slice(-8);

  let folderName = baseTitle;
  let target = path.join(outDir, projName, folderName);
  let dedup = 2;
  while (usedPaths.has(target.toLowerCase())) {
    folderName = `${baseTitle}_${suffix}_${dedup}`;
    target = path.join(outDir, projName, folderName);
    dedup++;
  }
  usedPaths.add(target.toLowerCase());

  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'conversation.json'), JSON.stringify(conv, null, 2));
  convs++;

  const srcAttachDir = path.join(attachPath, projName, baseTitle);
  if (fs.existsSync(srcAttachDir) && fs.statSync(srcAttachDir).isDirectory()) {
    const files = fs.readdirSync(srcAttachDir).filter(f => !f.startsWith('.') && f !== '_failed-attachments.json');
    if (files.length > 0) convsWithAttachments++;
    for (const file of files) {
      const src = path.join(srcAttachDir, file);
      const dst = path.join(target, file);
      try {
        fs.copyFileSync(src, dst);
        attachmentsCopied++;
      } catch (e) {
        console.error(`Failed to copy ${src}: ${e.message}`);
      }
    }
  }
}

const { conversations, ...metadata } = data;
fs.writeFileSync(path.join(outDir, 'export-metadata.json'), JSON.stringify(metadata, null, 2));

console.log(`Done: ${convs} conversations, ${convsWithAttachments} with attachments, ${attachmentsCopied} attachment files copied.`);
console.log(`Output: ${outDir}/`);
