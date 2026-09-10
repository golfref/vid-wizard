import { existsSync } from 'node:fs';
import path from 'node:path';

export function configureProjectEnvironment({ cwd = process.cwd(), environment = process.env, exists = existsSync } = {}) {
  const virtualEnvironmentBin = path.join(cwd, '.venv', 'bin');
  if (!exists(virtualEnvironmentBin)) return false;

  const currentPath = environment.PATH ?? '';
  const entries = currentPath.split(path.delimiter).filter(Boolean);
  if (entries.includes(virtualEnvironmentBin)) return false;
  environment.PATH = [virtualEnvironmentBin, ...entries].join(path.delimiter);
  return true;
}
