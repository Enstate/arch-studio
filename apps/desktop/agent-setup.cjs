const { spawn, spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { chmod, mkdtemp, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// Anthropic's official installers. The renderer names a provider, never a command.
const installers = {
  claude: platform => platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex']]
    // pipefail keeps a failed download from looking like a finished install.
    : ['/bin/bash', ['-c', 'set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash']],
};
const signInHosts = new Set(['claude.com', 'claude.ai', 'platform.claude.com']);
const terminalCodes = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
const outputLines = text => text.replace(terminalCodes, '').split(/\r\n|\r|\n/).map(line => line.trim()).filter(Boolean);
/** The sign-in page `claude auth login` prints, when it is one of Anthropic's own. */
function signInUrl(output) {
  for (const match of output.replace(terminalCodes, '').matchAll(/https:\/\/[^\s"'<>]+/g)) {
    try {
      const url = new URL(match[0]);
      if (url.protocol === 'https:' && signInHosts.has(url.hostname) && !url.username && !url.password && !url.port) return url.href;
    } catch {}
  }
  return null;
}
const validCode = value => typeof value === 'string' && /^[\x21-\x7e]{1,4096}$/.test(value.trim());

/** Installs Claude Code and signs it in from Studio. One operation runs at a time. */
function createAgentSetup({ environment, publish, openExternal, openPath, platform = process.platform, timers = globalThis }) {
  const windows = platform === 'win32';
  let state = { provider: 'claude', status: 'idle', lines: [] };
  let child;
  // The sign-in page of the running `claude auth login`, kept here so the renderer never holds it.
  let signInPage = null;
  let cancelled = false;
  let finished;
  let disposed = false;
  const emit = patch => {
    if (disposed) return;
    state = { provider: 'claude', lines: [], ...patch };
    publish(state);
  };
  const claudePath = env => {
    const name = windows ? 'claude.exe' : 'claude';
    for (const directory of (env.PATH ?? '').split(windows ? ';' : ':')) {
      const candidate = directory && path.join(directory, name);
      if (candidate && path.isAbsolute(candidate) && existsSync(candidate)) return candidate;
    }
    return null;
  };
  const stop = () => {
    const running = child;
    if (!running?.pid) return;
    if (windows) spawnSync('taskkill', ['/pid', String(running.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else try { process.kill(-running.pid, 'SIGTERM'); } catch { running.kill('SIGTERM'); }
  };
  const run = (command, args, env, stdin) => spawn(command, args, { env, stdio: [stdin, 'pipe', 'pipe'], detached: !windows, windowsHide: true });

  async function install(provider) {
    if (child || !installers[provider]) return state;
    const env = await environment();
    const [command, args] = installers[provider](platform);
    emit({ status: 'installing' });
    let recent = [];
    const code = await new Promise(resolve => {
      const installer = run(command, args, env, 'ignore');
      child = installer;
      const timer = timers.setTimeout(stop, 10 * 60_000);
      const receive = data => {
        recent = [...recent, ...outputLines(String(data))].slice(-4).map(line => line.slice(0, 200));
        emit({ status: 'installing', lines: recent });
      };
      installer.stdout.on('data', receive);
      installer.stderr.on('data', receive);
      installer.once('error', () => { timers.clearTimeout(timer); resolve(-1); });
      installer.once('close', exitCode => { timers.clearTimeout(timer); resolve(exitCode); });
    });
    child = undefined;
    emit(code === 0 && claudePath(env) ? { status: 'installed' } : { status: 'install-failed', lines: recent });
    return state;
  }

  // A Terminal or PowerShell window with the sign-in command typed, for when the browser flow can't run here.
  async function openTerminal(claude, env) {
    try {
      if (platform === 'darwin') {
        // Terminal opens .command files through Launch Services, without Apple Events permission.
        const directory = await mkdtemp(path.join(os.tmpdir(), 'arch-claude-sign-in-'));
        const script = path.join(directory, 'Claude sign-in.command');
        await writeFile(script, `#!/bin/bash\n'${claude.replaceAll("'", "'\\''")}' auth login\n`, { mode: 0o700 });
        await chmod(script, 0o700);
        const failure = await openPath(script);
        const cleanup = timers.setTimeout(() => { void rm(directory, { recursive: true, force: true }); }, 60_000);
        cleanup.unref?.();
        return !failure;
      }
      if (windows) {
        // A detached console process gets its own visible window.
        spawn('powershell.exe', ['-NoExit', '-Command', `& '${claude.replaceAll("'", "''")}' auth login`], { env, detached: true, stdio: 'ignore' }).unref();
        return true;
      }
    } catch {}
    return false;
  }

  async function signIn(provider) {
    if (finished) return finished;
    if (child || provider !== 'claude') return state;
    const env = await environment();
    const claude = claudePath(env);
    if (!claude) { emit({ status: 'sign-in-failed' }); return state; }
    cancelled = false;
    emit({ status: 'signing-in' });
    finished = new Promise(resolve => {
      const login = run(claude, ['auth', 'login'], env, 'pipe');
      child = login;
      // The output carries the sign-in link only. The code goes to stdin and is never echoed or kept.
      let output = '';
      let opened = false;
      // No link within 15 seconds means this CLI version wants a terminal.
      const linkTimer = timers.setTimeout(stop, 15_000);
      const abandonTimer = timers.setTimeout(() => { cancelled = true; stop(); }, 15 * 60_000);
      const receive = data => {
        if (opened) return;
        output = (output + String(data)).slice(-16_384);
        const url = signInUrl(output);
        if (!url) return;
        opened = true;
        timers.clearTimeout(linkTimer);
        // The CLI opens the browser itself. Studio reopens the page only when asked.
        signInPage = url;
        emit({ status: 'waiting-for-code' });
      };
      login.stdout.on('data', receive);
      login.stderr.on('data', receive);
      login.stdin.on('error', () => {});
      let settled = false;
      const settle = async exitCode => {
        if (settled) return;
        settled = true;
        timers.clearTimeout(linkTimer); timers.clearTimeout(abandonTimer);
        child = undefined;
        signInPage = null;
        if (exitCode === 0) emit({ status: 'signed-in' });
        else if (cancelled) emit({ status: 'idle' });
        else emit({ status: await openTerminal(claude, env) ? 'terminal' : 'sign-in-failed' });
        finished = undefined;
        resolve(state);
      };
      login.once('error', () => void settle(-1));
      login.once('close', exitCode => void settle(exitCode));
    });
    return finished;
  }

  function submitCode(code) {
    if (state.status !== 'waiting-for-code' || !child?.stdin?.writable || !validCode(code)) return state;
    child.stdin.write(`${code.trim()}\n`);
    emit({ status: 'signing-in' });
    return finished ?? state;
  }

  function openSignInPage() {
    if (state.status === 'waiting-for-code' && signInPage) void Promise.resolve(openExternal(signInPage)).catch(() => {});
    return state;
  }

  function cancelSignIn() {
    if (!finished) return state;
    cancelled = true;
    stop();
    return finished;
  }

  function dispose() {
    cancelled = true;
    stop();
    disposed = true;
  }

  return { getState: () => state, install, signIn, submitCode, openSignInPage, cancelSignIn, dispose };
}

module.exports = { createAgentSetup, signInUrl };
