import assert from 'node:assert/strict';
import test from 'node:test';
import { assertVideoTools, cutShots } from '../poc/src/video-service.js';

test('cuts each shot to a deterministic H.264 MP4 path', async () => {
  const calls = [];
  const outputs = await cutShots({
    inputPath: '/tmp/source.mp4',
    shots: [{ id: 'shot-001', startSeconds: 0, endSeconds: 2 }],
    outputDirectory: '/tmp/shots',
    run: async (command, args) => { calls.push({ command, args }); }
  });

  assert.deepEqual(outputs, [{ id: 'shot-001', localVideoPath: '/tmp/shots/shot-001.mp4' }]);
  assert.equal(calls[0].command, 'ffmpeg');
  assert.deepEqual(calls[0].args, ['-y', '-ss', '0', '-i', '/tmp/source.mp4', '-t', '2', '-c:v', 'libx264', '-c:a', 'aac', '/tmp/shots/shot-001.mp4']);
});

test('reports the missing media executable by name', async () => {
  await assert.rejects(
    () => assertVideoTools({ run: async (command) => { if (command === 'scenedetect') throw new Error('not found'); } }),
    /scenedetect.*pip install/i
  );
});

test('checks PySceneDetect availability with its portable help command', async () => {
  const calls = [];
  await assertVideoTools({ run: async (command, args) => { calls.push({ command, args }); } });
  assert.deepEqual(calls, [
    { command: 'scenedetect', args: ['--help'] },
    { command: 'ffmpeg', args: ['-version'] },
    { command: 'ffprobe', args: ['-version'] }
  ]);
});

test('does not require PySceneDetect for a manual shot plan', async () => {
  const calls = [];
  await assertVideoTools({ requireSceneDetection: false, run: async (command, args) => { calls.push([command, args]); } });
  assert.deepEqual(calls.map(([command]) => command), ['ffmpeg', 'ffprobe']);
});
