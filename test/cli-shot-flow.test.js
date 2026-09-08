import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';

test('run-shots dry-run writes a record for every manual shot', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'vidwizard-cli-'));
  const manifestPath = path.join(directory, 'manifest.json');
  const runsDirectory = path.join(directory, 'runs');
  await writeFile(manifestPath, JSON.stringify({
    model: 'bytedance/seedance-2-5', resolution: '480p', aspectRatio: '16:9', durationSeconds: 5,
    reference: { slot: 1, imageUrl: 'https://assets.example/person.jpg' },
    template: {
      id: 'horse-riding', localVideoPath: '/tmp/source.mp4', basePrompt: 'Replace the person.',
      sceneDetection: { mode: 'auto-with-override', minShotDurationSeconds: 1, adaptiveThreshold: 3 },
      shots: [
        { id: 'shot-001', startSeconds: 0, endSeconds: 2, publicVideoUrl: 'https://assets.example/one.mp4' },
        { id: 'shot-002', startSeconds: 2, endSeconds: 5, publicVideoUrl: 'https://assets.example/two.mp4' }
      ]
    }
  }));

  const result = await runCli(['poc/src/cli.js', 'run-shots', '--manifest', manifestPath, '--mode', 'dry-run', '--runs-dir', runsDirectory]);
  assert.equal(result.code, 0, result.stderr);
  const runFolders = await readdir(runsDirectory);
  const files = await readdir(path.join(runsDirectory, runFolders[0]));
  assert.equal(files.filter((file) => file.endsWith('.json')).length, 2);
});

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn('node', args, { cwd: process.cwd() });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

test('dry-run resume fails before touching paid records', async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'vw-paid-'));
 const file=path.join(dir,'paid.json');
 await writeFile(file,'{"status":"processing","taskId":"paid"}');
 const result=await runCli(['poc/src/cli.js','run-shots','--resume-dir',dir,'--mode','dry-run']);
 assert.notEqual(result.code,0);
 assert.match(result.stderr,/only allowed in live mode/);
 assert.equal(await (await import('node:fs/promises')).readFile(file,'utf8'),'{"status":"processing","taskId":"paid"}');
});
