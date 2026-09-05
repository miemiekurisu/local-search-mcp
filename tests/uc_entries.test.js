import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'lsm-entries-'));

function childEnv(port) {
  const env = { ...process.env };
  env.ARTIFACT_DIR = join(scratch, 'artifacts');
  env.BROWSER_STATE_DIR = join(scratch, 'browser');
  env.PAPER_CACHE_ENABLED = 'false';
  delete env.ENABLE_PAPER_TOOLS;
  if (port !== undefined) env.PORT = String(port);
  else delete env.PORT;
  return env;
}

function waitFor(buffer, needle, child, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (buffer.text.includes(needle)) { resolve(); return; }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`timeout waiting for ${needle}; stdout so far: ${buffer.text.slice(0, 2000)}`));
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
    child.once('exit', (code) => {
      if (!buffer.text.includes(needle)) {
        reject(new Error(`child exited early (code ${code}); stdout: ${buffer.text.slice(0, 2000)}`));
      }
    });
  });
}

test('mcp_server stdio handshake and exit on stdin end', async () => {
  const child = spawn(process.execPath, ['src/mcp_server.js'], {
    cwd: ROOT, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe']
  });
  const stdoutChunks = [];
  child.stdout.on('data', (c) => stdoutChunks.push(c));
  const stderrChunks = [];
  child.stderr.on('data', (c) => stderrChunks.push(c));
  const buffer = { get text() { return Buffer.concat(stdoutChunks).toString('utf8'); } };

  try {
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '0' } }
    }) + '\n');
    await waitFor(buffer, '"serverInfo"', child);
    const line = buffer.text.split('\n').find(l => l.includes('"serverInfo"'));
    const reply = JSON.parse(line);
    assert.equal(reply.result.serverInfo.name, 'local-search-mcp');
    assert.equal(reply.result.protocolVersion, '2024-11-05');

    child.stdin.end();
    const exit = await new Promise(resolve => child.once('exit', (code) => resolve(code)));
    assert.equal(exit, 0, `exit code after stdin end (stderr: ${Buffer.concat(stderrChunks).toString('utf8').slice(0, 500)})`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});

test('mcp_server logs unhandled rejections without crashing', async () => {
  const env = childEnv();
  env.NODE_OPTIONS = '--import=data:text/javascript,Promise.reject(7)';
  const child = spawn(process.execPath, ['src/mcp_server.js'], {
    cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe']
  });
  const stdoutChunks = [];
  child.stdout.on('data', (c) => stdoutChunks.push(c));
  const stderrChunks = [];
  child.stderr.on('data', (c) => stderrChunks.push(c));
  const buffer = { get text() { return Buffer.concat(stdoutChunks).toString('utf8'); } };

  try {
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '0' } }
    }) + '\n');
    await waitFor(buffer, '"serverInfo"', child);
    const stderr = Buffer.concat(stderrChunks).toString('utf8').replace(/\x1b\[[0-9;]*m/g, '');
    assert.ok(stderr.includes('Unhandled rejection:'), stderr.slice(0, 500));

    child.stdin.end();
    const exit = await new Promise(resolve => child.once('exit', (code) => resolve(code)));
    assert.equal(exit, 0, 'unhandled rejection must not kill the server');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});

test('http_server binds PORT and serves /health', async () => {
  const port = 38000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, ['src/http_server.js'], {
    cwd: ROOT, env: childEnv(port), stdio: ['pipe', 'pipe', 'pipe']
  });
  const stdoutChunks = [];
  child.stdout.on('data', (c) => stdoutChunks.push(c));
  const stderrChunks = [];
  child.stderr.on('data', (c) => stderrChunks.push(c));
  const buffer = { get text() { return Buffer.concat(stdoutChunks).toString('utf8'); } };

  try {
    await waitFor(buffer, 'HTTP server listening', child);
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  } finally {
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
  }
});

test('http_server prints usage error when port is in use', async () => {
  const net = await import('node:net');
  const blocker = net.createServer();
  await new Promise(resolve => blocker.listen(0, '0.0.0.0', resolve));
  const port = blocker.address().port;

  const child = spawn(process.execPath, ['src/http_server.js'], {
    cwd: ROOT, env: childEnv(port), stdio: ['pipe', 'pipe', 'pipe']
  });
  const stderrChunks = [];
  child.stderr.on('data', (c) => stderrChunks.push(c));
  const stdoutChunks = [];
  child.stdout.on('data', (c) => stdoutChunks.push(c));
  try {
    const code = await new Promise(resolve => child.once('exit', (c) => resolve(c)));
    const errText = Buffer.concat(stderrChunks).toString('utf8');
    assert.notEqual(code, 0, `expected nonzero exit (stderr: ${errText.slice(0, 500)})`);
  } finally {
    blocker.close();
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});

test('cleanup scratch dir', () => {
  rmSync(scratch, { recursive: true, force: true });
});
