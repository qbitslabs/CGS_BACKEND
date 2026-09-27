/**
 * Free TCP port used by CGS Backend (default 4000).
 * Usage: npx tsx scripts/free-port.ts [port]
 */
import { execSync } from 'child_process';

const port = Number(process.argv[2] || process.env.PORT || 4000);

function freePortWindows(p: number) {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${p} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique"`,
      { encoding: 'utf8' }
    );
    const pids = [
      ...new Set(
        out
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => /^\d+$/.test(s) && s !== '0')
      ),
    ];
    if (!pids.length) {
      console.log(`[free-port] Nothing listening on ${p}`);
      return;
    }
    for (const pid of pids) {
      try {
        execSync(`taskkill /PID ${pid} /F`, { stdio: 'inherit' });
        console.log(`[free-port] Killed PID ${pid} on port ${p}`);
      } catch {
        console.warn(`[free-port] Could not kill PID ${pid}`);
      }
    }
  } catch {
    console.log(`[free-port] Nothing listening on ${p}`);
  }
}

function freePortUnix(p: number) {
  try {
    const out = execSync(`lsof -ti tcp:${p}`, { encoding: 'utf8' }).trim();
    const pids = out.split(/\s+/).filter(Boolean);
    for (const pid of pids) {
      execSync(`kill -9 ${pid}`, { stdio: 'inherit' });
      console.log(`[free-port] Killed PID ${pid} on port ${p}`);
    }
  } catch {
    console.log(`[free-port] Nothing listening on ${p}`);
  }
}

if (process.platform === 'win32') {
  freePortWindows(port);
} else {
  freePortUnix(port);
}
