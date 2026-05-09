'use strict';

/**
 * Stem splitting via Demucs (Meta AI).
 *
 * Requires Python 3.8+ and Demucs installed:
 *   pip install demucs
 *
 * Demucs outputs: vocals, drums, bass, other
 * Model used: htdemucs (default, fast + accurate)
 */

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const VALID_STEMS = ['vocals', 'drums', 'bass', 'other', 'all'];
const DEMUCS_MODEL = 'htdemucs';

/**
 * Check that Python and Demucs are available.
 * Returns { ok: true } or { ok: false, message: string }
 */
async function checkDemucs() {
  // Try python3 then python
  const pyCmd = await findPython();
  if (!pyCmd) {
    return {
      ok: false,
      message:
        'Python not found. Install Python 3.8+ from https://python.org then run: pip install demucs',
    };
  }

  return new Promise((resolve) => {
    execFile(pyCmd, ['-m', 'demucs', '--help'], { timeout: 10000 }, (err) => {
      if (err) {
        resolve({
          ok: false,
          message: `Demucs not found. Install it with: ${pyCmd} -m pip install demucs`,
        });
      } else {
        resolve({ ok: true, cmd: pyCmd });
      }
    });
  });
}

async function findPython() {
  for (const cmd of ['python', 'python3']) {
    const found = await new Promise((resolve) => {
      execFile(cmd, ['--version'], { timeout: 5000 }, (err) => resolve(!err ? cmd : null));
    });
    if (found) return found;
  }
  return null;
}

/**
 * Split an audio file into stems using Demucs.
 *
 * @param {string} inputPath   - Path to the source audio file (mp3/wav/flac/etc.)
 * @param {string} outputDir   - Directory where stems folder will be created
 * @param {string[]} stems     - Which stems to keep: subset of VALID_STEMS (minus 'all')
 *                               Pass ['vocals','drums','bass','other'] or leave empty for all 4
 * @param {function} onProgress - Optional callback(line) for progress output
 * @returns {Promise<{ [stem]: string }>} - Map of stem name → file path
 */
async function splitStems(inputPath, outputDir, stems = [], onProgress = null) {
  const check = await checkDemucs();
  if (!check.ok) throw new Error(check.message);

  const pyCmd = check.cmd;
  const wantAll = stems.length === 0 || stems.includes('all');
  const wantedStems = wantAll ? ['vocals', 'drums', 'bass', 'other'] : stems;

  // Demucs writes: <outputDir>/<model>/<track_name>/{vocals,drums,bass,other}.wav
  await fs.promises.mkdir(outputDir, { recursive: true });

  await new Promise((resolve, reject) => {
    const args = [
      '-m', 'demucs',
      '--name', DEMUCS_MODEL,
      '--out', outputDir,
      inputPath,
    ];

    const proc = spawn(pyCmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = [];

    const onLine = (data) => {
      const line = data.toString();
      lines.push(line);
      if (onProgress) onProgress(line.trim());
    };

    proc.stdout.on('data', onLine);
    proc.stderr.on('data', onLine); // Demucs logs to stderr

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Demucs exited with code ${code}. Output:\n${lines.slice(-10).join('')}`));
      }
    });
    proc.on('error', reject);
  });

  // Find the output folder: outputDir/htdemucs/<basename_no_ext>/
  const trackName = path.basename(inputPath, path.extname(inputPath));
  const stemDir = path.join(outputDir, DEMUCS_MODEL, trackName);

  if (!fs.existsSync(stemDir)) {
    throw new Error(`Demucs finished but output folder not found: ${stemDir}`);
  }

  // Collect requested stem files
  const result = {};
  for (const stem of wantedStems) {
    const stemPath = path.join(stemDir, `${stem}.wav`);
    if (!fs.existsSync(stemPath)) {
      throw new Error(`Expected stem file not found: ${stemPath}`);
    }
    result[stem] = stemPath;
  }

  return result;
}

module.exports = { checkDemucs, splitStems, VALID_STEMS };
