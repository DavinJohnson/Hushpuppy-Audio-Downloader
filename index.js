#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { sanitizeFilename } = require('./lib');
const { detectPlatform } = require('./platforms');

const CONCURRENCY = 3;

async function pool(thunks, limit) {
  const results = new Array(thunks.length);
  let next = 0;
  async function worker() {
    while (next < thunks.length) {
      const i = next++;
      results[i] = await thunks[i]();
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

async function downloadOne(input, outDir, index, total) {
  const prefix = total > 1 ? `[${index}/${total}] ` : '';
  const trimmed = input.trim();

  const platform = detectPlatform(trimmed);
  if (!platform) {
    console.error(`${prefix}SKIP — unsupported URL: ${trimmed}`);
    return { ok: false, input };
  }

  let info;
  try {
    info = await platform.getInfo(trimmed);
  } catch (err) {
    console.error(`${prefix}FAIL — ${err.message} (${trimmed})`);
    return { ok: false, input };
  }

  const bpmSuffix = info.bpm ? ` (${info.bpm} BPM)` : '';
  const filename = sanitizeFilename(`${info.artist} - ${info.title}${bpmSuffix}.${info.ext}`);
  const destPath = path.join(outDir, filename);

  if (fs.existsSync(destPath)) {
    console.log(`${prefix}SKIP — already exists: ${filename}`);
    return { ok: true, input, skipped: true };
  }

  console.log(`${prefix}Downloading: ${info.artist} - ${info.title}${bpmSuffix}`);

  try {
    await platform.downloadTrack(trimmed, destPath);
    console.log(`${prefix}Done: ${filename}`);
    return { ok: true, input, destPath };
  } catch (err) {
    console.error(`${prefix}FAIL — ${err.message}`);
    if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
    return { ok: false, input };
  }
}

function parseInputs(args) {
  const inputs = [];
  let outDir = null;
  let i = 0;

  while (i < args.length) {
    const arg = args[i];
    if (arg === '--output' || arg === '-o') {
      outDir = args[++i];
    } else if (arg === '--file' || arg === '-f') {
      const filePath = args[++i];
      if (!fs.existsSync(filePath)) {
        console.error(`Error: file not found: ${filePath}`);
        process.exit(1);
      }
      inputs.push(...readLinkFile(filePath));
    } else if (!arg.startsWith('-')) {
      if ((arg.endsWith('.txt') || arg.endsWith('.TXT')) && fs.existsSync(arg)) {
        inputs.push(...readLinkFile(arg));
      } else {
        inputs.push(arg);
      }
    }
    i++;
  }

  return { inputs, outDir };
}

function readLinkFile(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

async function run() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
hushpuppy — download audio from BeatStars, SoundCloud, TrakTrain, and YouTube

Usage:
  node index.js <url> [url ...] [-o output-dir]
  node index.js links.txt [-o output-dir]
  node index.js -f links.txt [-o output-dir]

Supported platforms:
  BeatStars   https://www.beatstars.com/beat/...
  SoundCloud  https://soundcloud.com/...
  TrakTrain   https://traktrain.com/...
  YouTube     https://www.youtube.com/watch?v=...

Options:
  -o, --output  Output directory (default: ~/Downloads)
  -f, --file    Path to a text file with one URL per line (# = comment)

Examples:
  node index.js https://www.beatstars.com/beat/some-beat/13199852
  node index.js https://soundcloud.com/producer/beat-name -o C:\\Beats
  node index.js links.txt
`);
    process.exit(0);
  }

  const { inputs, outDir: rawOutDir } = parseInputs(args);
  const outDir = rawOutDir ? path.resolve(rawOutDir) : path.join(os.homedir(), 'Downloads');

  if (inputs.length === 0) {
    console.error('Error: no URLs provided.');
    process.exit(1);
  }

  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const total = inputs.length;
  console.log(`\nhushpuppy — ${total} track${total === 1 ? '' : 's'} to download`);
  console.log(`Output: ${outDir}`);
  if (total > 1) console.log(`Concurrency: ${CONCURRENCY} at a time\n`);

  const thunks = inputs.map((input, i) => () => downloadOne(input, outDir, i + 1, total));
  const results = await pool(thunks, CONCURRENCY);

  if (total > 1) {
    const ok = results.filter((r) => r.ok && !r.skipped).length;
    const skipped = results.filter((r) => r.ok && r.skipped).length;
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\nDone. ${ok} downloaded, ${skipped} skipped, ${failed} failed.`);
  }
}

run();
