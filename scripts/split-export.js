#!/usr/bin/env node
/**
 * Split a ChatGPT export JSON into individual files organized by project.
 *
 * Output structure:
 *   <out-dir>/
 *     projects/
 *       <Project Name>/
 *         <Conversation Title>_<id-suffix>.json
 *     no-project/
 *       <Conversation Title>_<id-suffix>.json
 *     export-metadata.json
 *
 * Usage: node split-export.js <export.json> [output-dir]
 */

const fs = require('fs');
const path = require('path');

function sanitize(s) {
  if (!s) return 'untitled';
  return s
    .replace(/[\/\\:*?"<>|\n\r\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || 'untitled';
}

const input = process.argv[2];
if (!input) {
  console.error('Usage: node split-export.js <export.json> [output-dir]');
  process.exit(1);
}

const inputPath = path.resolve(input);
const outDir = path.resolve(process.argv[3] || inputPath.replace(/\.json$/, ''));

console.log(`Reading ${inputPath}...`);
const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

fs.mkdirSync(outDir, { recursive: true });

const usedPaths = new Set();
let count = 0;

for (const conv of (data.conversations || [])) {
  const projDir = conv.project_name
    ? path.join(outDir, 'projects', sanitize(conv.project_name))
    : path.join(outDir, 'no-project');
  fs.mkdirSync(projDir, { recursive: true });

  const baseName = sanitize(conv.title || 'untitled');
  const suffix = (conv.id || '').slice(-8);
  let filename = `${baseName}_${suffix}.json`;
  let filepath = path.join(projDir, filename);

  let dedup = 2;
  while (usedPaths.has(filepath)) {
    filename = `${baseName}_${suffix}_${dedup}.json`;
    filepath = path.join(projDir, filename);
    dedup++;
  }
  usedPaths.add(filepath);

  fs.writeFileSync(filepath, JSON.stringify(conv, null, 2));
  count++;
}

const { conversations, ...metadata } = data;
fs.writeFileSync(
  path.join(outDir, 'export-metadata.json'),
  JSON.stringify(metadata, null, 2)
);

console.log(`Split ${count} conversations into ${outDir}/`);
console.log(`Metadata at ${outDir}/export-metadata.json`);
