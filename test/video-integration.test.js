import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFile, mkdtemp, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { assembleApprovedShots } from '../poc/src/review-service.js';
import { probeMedia, runProcess } from '../poc/src/video-service.js';

const review = { usable: true, identityMappingPass: true, backgroundPreserved: true, motionPreserved: true, flickerAcceptable: true, seamAcceptable: null, failureReasons: [], notes: 'approved' };

async function makeMedia(directory) {
  const source = path.join(directory, 'source.mp4');
  const one = path.join(directory, 'one.mp4');
  const two = path.join(directory, 'two.mp4');
  await runProcess('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source]);
  await runProcess('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=15', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', one]);
  await runProcess('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=1280x720:r=60', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', two]);
  return { source, one, two };
}

function record(shotId, file) {
  return { shotId, status: 'success', outputVideoUrl: file, source: { durationSeconds: 1 }, qualityReview: review };
}

test('assembles synthetic clips with fixed dimensions, audio, duration and atomic rename', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'vidwizard-assemble-'));
  const { source, one, two } = await makeMedia(directory);
  const output = path.join(directory, 'final.mp4');
  const artifact = await assembleApprovedShots({
    records: [record('shot-001', one), record('shot-002', two)], expectedShotIds: ['shot-001', 'shot-002'],
    outputPath: output, tempDirectory: path.join(directory, 'work'), sourceAudioPath: source,
    download: async (file, destination) => copyFile(file, destination), probe: (inputPath) => probeMedia({ inputPath }), run: runProcess, normalize: true
  });
  const media = await probeMedia({ inputPath: output });
  assert.ok(media.durationSeconds >= 1.9 && media.durationSeconds <= 2.1, `duration=${media.durationSeconds}`);
  assert.deepEqual(media.streams.filter((stream) => stream.codec_type).map((stream) => stream.codec_type).sort(), ['audio', 'video']);
  const video = media.streams.find((stream) => stream.codec_type === 'video');
  assert.equal(video.width, 854);
  assert.equal(video.height, 480);
  assert.equal(artifact.finalReview, null);
  await assert.rejects(() => stat(`${output}.tmp-${process.pid}.mp4`));
});

test('rejects a downloaded shot whose duration exceeds its source interval', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'vidwizard-duration-'));
  const { one } = await makeMedia(directory);
  await assert.rejects(() => assembleApprovedShots({
    records: [{ ...record('shot-001', one), source: { durationSeconds: 0 } }], expectedShotIds: ['shot-001'],
    outputPath: path.join(directory, 'final.mp4'), tempDirectory: path.join(directory, 'work'),
    download: async (file, destination) => copyFile(file, destination), probe: (inputPath) => probeMedia({ inputPath }), run: runProcess, normalize: true
  }), /does not match source interval/);
});

test('source without audio still produces a complete video', async () => {
 const directory=await mkdtemp(path.join(tmpdir(),'vidwizard-silent-'));
 const {one,two}=await makeMedia(directory);
 const result=await assembleApprovedShots({records:[record('shot-002',two),record('shot-001',one)],expectedShotIds:['shot-001','shot-002'],outputPath:path.join(directory,'final.mp4'),tempDirectory:path.join(directory,'work'),sourceAudioPath:one,expectedDurationSeconds:2,download:copyFile,probe:inputPath=>probeMedia({inputPath}),normalize:true});
 assert.deepEqual(result.shotIds,['shot-001','shot-002']);
 assert.ok(Math.abs(result.finalDurationSeconds-2)<0.1);
 assert.equal(result.media.streams.some(s=>s.codec_type==='audio'),false);
});

test('CLI assembles snapshot, persists final review, and reports nested generation', async()=>{
 const {mkdir,writeFile,readFile}=await import('node:fs/promises');
 const {createServer}=await import('node:http');
 const {resolveShotPlan}=await import('../poc/src/shot-plan.js');
 const directory=await mkdtemp(path.join(tmpdir(),'vw-cli-final-'));
 const {source,one,two}=await makeMedia(directory);
 const server=createServer(async(req,res)=>{res.end(await readFile(req.url==='/one'?one:two))});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
 const runs=path.join(directory,'runs'); await mkdir(path.join(runs,'.meta'),{recursive:true});
 const manifest={resolution:'480p',aspectRatio:'16:9',reference:{slot:1,imageUrl:'https://example.com/person.jpg'},template:{id:'demo',localVideoPath:source,basePrompt:'Replace',sceneDetection:{mode:'auto-with-override',minShotDurationSeconds:1,adaptiveThreshold:3},shots:[]}};
 const plan=resolveShotPlan(manifest,[{id:'b',startSeconds:0,endSeconds:1},{id:'a',startSeconds:1,endSeconds:2}],{sourceDuration:2});
 await writeFile(path.join(runs,'.meta','g.generation.json'),JSON.stringify({generationId:'g',templateId:'demo',mode:'live',startedAt:new Date().toISOString(),expectedShotIds:['b','a'],sourceDurationSeconds:2,planHash:plan.planHash,planSnapshot:plan,manifestSnapshot:manifest}));
 for(const [i,id] of ['b','a'].entries()) await writeFile(path.join(runs,id+'.json'),JSON.stringify({...record(id,`http://127.0.0.1:${server.address().port}/${i?'two':'one'}`),runId:id,generationId:'g',templateId:'demo',source:{startSeconds:i,endSeconds:i+1,durationSeconds:1},costUsd:1,creditsConsumed:10}));
 await runProcess('node',['poc/src/cli.js','assemble','--runs-dir',runs]);
 let final=JSON.parse(await readFile(path.join(runs,'final-record.json'))); assert.equal(final.finalReview,null); assert.deepEqual(final.shotIds,['b','a']);
 await writeFile(path.join(directory,'review.json'),JSON.stringify({usable:true,notes:'Final reviewed'}));
 await runProcess('node',['poc/src/cli.js','final-review','--runs-dir',runs,'--review',path.join(directory,'review.json')]);
 await runProcess('node',['poc/src/cli.js','report','--runs-dir',directory]);
 const report=await readFile(path.join(directory,'round-1-results.md'),'utf8'); assert.match(report,/demo/); assert.match(report,/2\.000/);
 assert.equal(JSON.parse(await readFile(path.join(runs,'a.json'))).actualDurationSeconds,1);
 } finally { await new Promise(resolve=>server.close(resolve)); }
});
