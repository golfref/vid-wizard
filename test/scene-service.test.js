import assert from 'node:assert/strict';
import test from 'node:test';
import { detectScenes, parseSceneCsv } from '../poc/src/scene-service.js';

test('parses PySceneDetect scene CSV and filters short scenes', () => {
  const csv = [
    'Scene Number,Start Time (seconds),End Time (seconds)',
    '1,0.000,0.800',
    '2,0.800,3.300'
  ].join('\n');

  assert.deepEqual(parseSceneCsv(csv, 1), [{ startSeconds: 0, endSeconds: 3.3 }]);
});

test('runs AdaptiveDetector and returns parsed scene boundaries', async () => {
  const calls = [];
  const run = async (command, args) => {
    calls.push({ command, args });
    return { stdout: 'Scene Number,Start Time (seconds),End Time (seconds)\n1,0,2.5\n' };
  };

  const shots = await detectScenes({
    inputPath: '/tmp/source.mp4',
    adaptiveThreshold: 3,
    minShotDurationSeconds: 1,
    outputDirectory: '/tmp/scene-results',
    run,
    readSceneFile: async () => 'Scene Number,Start Time (seconds),End Time (seconds)\n1,0,2.5\n'
  });

  assert.deepEqual(shots, [{ startSeconds: 0, endSeconds: 2.5 }]);
  assert.equal(calls[0].command, 'scenedetect');
  assert.deepEqual(calls[0].args, ['-i', '/tmp/source.mp4', 'detect-adaptive', '--threshold', '3', 'list-scenes', '--output', '/tmp/scene-results', '--filename', 'scenes.csv', '--skip-cuts']);
});
