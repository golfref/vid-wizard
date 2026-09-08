import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

export async function assertVideoTools({ run = runProcess } = {}) {
  for (const executable of ['scenedetect', 'ffmpeg', 'ffprobe']) {
    try {
      // PySceneDetect 0.6.x does not implement a --version flag, whereas
      // FFmpeg tools use -version. Its help command is a portable availability
      // check and exits without processing media.
      await run(executable, [executable === 'scenedetect' ? '--help' : '-version']);
    } catch (error) {
      const install = executable === 'scenedetect' ? 'Install it with: python3 -m pip install "scenedetect[opencv]".' : 'Install FFmpeg (which provides ffmpeg and ffprobe).';
      throw new Error(`Required executable '${executable}' is unavailable. ${install}`, { cause: error });
    }
  }
}

export async function probeMedia({ inputPath, run = runProcess }) {
  const result = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=index,codec_type,codec_name,width,height,r_frame_rate', '-of', 'json', inputPath]);
  const parsed = JSON.parse(result.stdout || '{}');
  const durationSeconds = Number(parsed.format?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error(`Cannot determine media duration for ${inputPath}.`);
  return { durationSeconds, streams: parsed.streams ?? [] };
}

export async function cutShots({ inputPath, shots, outputDirectory, run = runProcess }) {
  await mkdir(outputDirectory, { recursive: true });
  const outputs = [];
  for (const shot of shots) {
    const localVideoPath = path.join(outputDirectory, `${shot.id}.mp4`);
    await run('ffmpeg', [
      '-y', '-ss', String(shot.startSeconds), '-i', inputPath,
      '-t', String(shot.endSeconds - shot.startSeconds),
      '-c:v', 'libx264', '-c:a', 'aac', localVideoPath
    ]);
    outputs.push({ id: shot.id, localVideoPath });
  }
  return outputs;
}

export function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}
