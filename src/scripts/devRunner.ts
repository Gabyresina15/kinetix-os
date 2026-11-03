import { spawn } from 'node:child_process';
import path from 'node:path';

const isReplay = process.argv.includes('--replay');
const mode = isReplay ? 'REPLAY' : process.env.ORCHESTRATOR_MODE || 'LIVE';
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const rootDir = process.cwd();
const clientDir = path.join(rootDir, 'client');

console.log(`[Kinetix Monorepo] Starting server (ORCHESTRATOR_MODE=${mode}) + client (Vite proxy -> :4000)...`);

const serverProc = spawn(npmCmd, ['run', isReplay ? 'server:replay' : 'server:dev'], {
  cwd: rootDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    ORCHESTRATOR_MODE: mode,
  },
});

const clientProc = spawn(npmCmd, ['run', 'dev'], {
  cwd: clientDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: {
    ...process.env,
  },
});

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    serverProc.kill();
  } catch {}
  try {
    clientProc.kill();
  } catch {}
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

serverProc.on('exit', (code) => {
  if (!shuttingDown && code && code !== 0) {
    shutdown(code);
  }
});

clientProc.on('exit', (code) => {
  if (!shuttingDown && code && code !== 0) {
    shutdown(code);
  }
});
