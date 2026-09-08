import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { runProcess } from './video-service.js';

export async function detectScenes({ inputPath, adaptiveThreshold, minShotDurationSeconds, outputDirectory, run = runProcess, readSceneFile = readFile }) {
  const directory = outputDirectory ?? await mkdtemp(path.join(tmpdir(), 'vidwizard-scenes-'));
  const csvPath = path.join(directory, 'scenes.csv');
  await run('scenedetect', [
    '-i', inputPath,
    'detect-adaptive', '--threshold', String(adaptiveThreshold),
    'list-scenes', '--output', directory, '--filename', 'scenes.csv', '--skip-cuts'
  ]);
  return parseSceneCsv(await readSceneFile(csvPath, 'utf8'), minShotDurationSeconds);
}

export function parseSceneCsv(csv, minShotDurationSeconds) {
  const lines = csv.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((value) => value.trim());
  const startIndex = headers.indexOf('Start Time (seconds)');
  const endIndex = headers.indexOf('End Time (seconds)');
  if (startIndex === -1 || endIndex === -1) throw new Error('PySceneDetect CSV is missing Start Time (seconds) or End Time (seconds).');
  const parsed = lines.slice(1).flatMap((line) => {
    const values = line.split(',').map((value) => value.trim());
    const startSeconds = Number(values[startIndex]);
    const endSeconds = Number(values[endIndex]);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) return [];
    return [{ startSeconds, endSeconds }];
  });
  // Keep the source timeline contiguous. Short detector fragments are merged
  // into the preceding shot instead of being silently discarded.
  const merged = parsed.reduce((shots, shot) => {
    if (shot.endSeconds - shot.startSeconds < minShotDurationSeconds && shots.length) {
      shots[shots.length - 1].endSeconds = shot.endSeconds;
    } else shots.push({ ...shot });
    return shots;
  }, []);
  if (merged.length > 1 && merged[0].endSeconds - merged[0].startSeconds < minShotDurationSeconds) {
    merged[1].startSeconds = merged[0].startSeconds;
    merged.shift();
  }
  return merged;
}
