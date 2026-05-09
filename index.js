#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { sanitizeFilename } = require('./lib');
const { detectPlatform } = require('./platforms');
const { checkDemucs, splitStems, VALID_STEMS } = require('./lib/stems');

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

async function downloadOne(input, outDir, index, total, stemsOpt) {
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

  if (fs.existsSync(destPath) && !stemsOpt) {
    console.log(`${prefix}SKIP — already exists: ${filename}`);
    return { ok: true, input, skipped: true };
  }

  console.log(`${prefix}Downloading: ${info.artist} - ${info.title}${bpmSuffix}`);

  try {
    if (!fs.existsSync(destPath)) {
      await platform.downloadTrack(trimmed, destPath);
    }
    console.log(`${prefix}Done: ${filename}`);

    if (stemsOpt) {
      await runStemSplit(destPath, outDir, stemsOpt, prefix, `${info.artist} - ${info.title}${bpmSuffix}`);
    }

    return { ok: true, input, destPath };
  } catch (err) {
    console.error(`${prefix}FAIL — ${err.message}`);
    if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
    return { ok: false, input };
  }
}

async function runStemSplit(audioPath, outDir, stemsOpt, prefix, trackLabel) {
  const wantedStems = stemsOpt === 'all' ? [] : [stemsOpt];
  console.log(`${prefix}Splitting stems (${stemsOpt}) for: ${trackLabel}`);
  console.log(`${prefix}  This may take a few minutes on first run (downloads model ~80MB)...`);

  try {
    const stemPaths = await splitStems(audioPath, outDir, wantedStems, (line) => {
      if (line) process.stdout.write(`\r${prefix}  ${line.slice(0, 80).padEnd(80)}`);
    });
    process.stdout.write('\n');

    // Move stems next to the source file with clear names
    const base = path.basename(audioPath, path.extname(audioPath));
    for (const [stem, stemPath] of Object.entries(stemPaths)) {
      const destName = sanitizeFilename(`${base} [${stem}].wav`);
      const destStem = path.join(outDir, destName);
      fs.renameSync(stemPath, destStem);
      console.log(`${prefix}  Stem: ${destName}`);
    }

    // Clean up the empty demucs output subdirs
    try {
      const demucsDir = path.join(outDir, 'htdemucs');
      if (fs.existsSync(demucsDir)) fs.rmSync(demucsDir, { recursive: true, force: true });
    } catch { /* ignore cleanup errors */ }

  } catch (err) {
    console.error(`${prefix}Stem split failed: ${err.message}`);
    throw err;
  }
}

function parseInputs(args) {
  const inputs = [];
  let outDir = null;
  let stemsOpt = null;
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
    } else if (arg === '--stems' || arg === '-s') {
      const val = (args[++i] || '').toLowerCase();
      if (!VALID_STEMS.includes(val)) {
        console.error(`Error: --stems must be one of: ${VALID_STEMS.join(', ')}`);
        process.exit(1);
      }
      stemsOpt = val;
    } else if (!arg.startsWith('-')) {
      if ((arg.endsWith('.txt') || arg.endsWith('.TXT')) && fs.existsSync(arg)) {
        inputs.push(...readLinkFile(arg));
      } else {
        inputs.push(arg);
      }
    }
    i++;
  }

  return { inputs, outDir, stemsOpt };
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
  node index.js <url> [url ...] [-o output-dir] [--stems <stem>]
  node index.js links.txt [-o output-dir] [--stems <stem>]
  node index.js -f links.txt [-o output-dir] [--stems <stem>]

Supported platforms:
  BeatStars   https://www.beatstars.com/beat/...
  SoundCloud  https://soundcloud.com/...
  TrakTrain   https://traktrain.com/...
  YouTube     https://www.youtube.com/watch?v=...

Options:
  -o, --output  Output directory (default: ~/Downloads)
  -f, --file    Path to a text file with one URL per line (# = comment)
  -s, --stems   Split into stems after download. Requires Python + Demucs.
                Values: vocals | drums | bass | other | all

Stem splitting:
  Requires Demucs: pip install demucs
  First run downloads the htdemucs model (~80MB). Subsequent runs are faster.
  Stem files are saved as "<track> [vocals].wav" etc. in the output folder.

Examples:
  node index.js https://www.beatstars.com/beat/some-beat/13199852
  node index.js https://soundcloud.com/producer/beat-name -o C:\\Beats
  node index.js links.txt
  node index.js https://soundcloud.com/producer/beat-name --stems vocals
  node index.js links.txt --stems all
`);
    process.exit(0);
  }

  const { inputs, outDir: rawOutDir, stemsOpt } = parseInputs(args);
  const outDir = rawOutDir ? path.resolve(rawOutDir) : path.join(os.homedir(), 'Downloads');

  if (inputs.length === 0) {
    console.error('Error: no URLs provided.');
    process.exit(1);
  }

  // Check Demucs early if stems requested
  if (stemsOpt) {
    const check = await checkDemucs();
    if (!check.ok) {
      console.error(`\nStem splitting unavailable: ${check.message}\n`);
      process.exit(1);
    }
    console.log(`Stem splitting: ${stemsOpt} (using Demucs htdemucs)`);
  }

  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const total = inputs.length;
  console.log(`\nhushpuppy — ${total} track${total === 1 ? '' : 's'} to download`);
  console.log(`Output: ${outDir}`);
  if (total > 1) console.log(`Concurrency: ${CONCURRENCY} at a time\n`);

  // Stem splitting is sequential (GPU-intensive), don't parallelize
  const effectiveConcurrency = stemsOpt ? 1 : CONCURRENCY;
  const thunks = inputs.map((input, i) => () => downloadOne(input, outDir, i + 1, total, stemsOpt));
  const results = await pool(thunks, effectiveConcurrency);

  if (total > 1) {
    const ok = results.filter((r) => r.ok && !r.skipped).length;
    const skipped = results.filter((r) => r.ok && r.skipped).length;
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\nDone. ${ok} downloaded, ${skipped} skipped, ${failed} failed.`);
  }
}

run();
