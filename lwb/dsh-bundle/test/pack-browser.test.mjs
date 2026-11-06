import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile, chmod, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dedicatedCommand, findChromium, findEgo } from '../pack-browser.mjs'

test('Chrome or Edge is found where each platform installs it, and only there', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lwb-browser-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.equal(findChromium({ platform: 'linux', env: { PATH: root } }), null)
  await writeFile(join(root, 'chromium'), '')
  assert.deepEqual(findChromium({ platform: 'linux', env: { PATH: root } }), { name: 'chromium', executable: join(root, 'chromium') })
  const program = join(root, 'pf')
  await mkdir(join(program, 'Microsoft', 'Edge', 'Application'), { recursive: true })
  await writeFile(join(program, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), '')
  assert.equal(findChromium({ platform: 'win32', env: { ProgramFiles: program } }).name, 'Microsoft Edge')
})

test('ego-browser is found on PATH, the way onboarding registers it', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lwb-ego-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const before = findEgo({ PATH: root })
  await writeFile(join(root, 'ego-browser'), '#!/bin/sh\n')
  await chmod(join(root, 'ego-browser'), 0o755)
  assert.equal(findEgo({ PATH: root }), join(root, 'ego-browser'))
  // Without it on PATH the answer is whatever ~/.local/bin holds, never the empty dir.
  assert.notEqual(before, join(root, 'ego-browser'))
})

test('the command a character runs names this node, this runner and the profile, quoted', () => {
  const command = dedicatedCommand("/tmp/it's here")
  assert.ok(command.includes(process.execPath))
  assert.match(command, /pack-browser\.mjs' run --dir '\/tmp\/it'\\''s here'$/u)
})

test('port file parses the two-line format and tolerates the legacy single line', async () => {
  const { parsePortFile } = await import('../pack-browser.mjs')
  assert.deepEqual(parsePortFile('9222\nChrome/131.0.0.0\n'), { port: 9222, fingerprint: 'Chrome/131.0.0.0' })
  assert.deepEqual(parsePortFile('9222\n'), { port: 9222, fingerprint: null })
  assert.deepEqual(parsePortFile('9222'), { port: 9222, fingerprint: null })
  assert.equal(parsePortFile('not-a-port\n').port, null)
})

async function fakeChrome(t, { browser = 'Chrome/131.0.0.0', versionPath = '/json/version' } = {}) {
  const { createServer } = await import('node:http')
  const server = createServer((request, response) => {
    if (request.url === versionPath) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ Browser: browser, webSocketDebuggerUrl: `ws://127.0.0.1:1/devtools/browser/x` }))
    } else { response.writeHead(404); response.end('no') }
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  t.after(() => new Promise((resolvePromise) => server.close(() => resolvePromise())))
  return server.address().port
}

test('a dedicated browser whose fingerprint matches is reused without launching', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lwb-cdp-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { ensureDedicated, formatPortFile } = await import('../pack-browser.mjs')
  const port = await fakeChrome(t)
  await mkdir(join(root, 'profile'), { recursive: true })
  await writeFile(join(root, 'cdp-port'), formatPortFile(port, 'Chrome/131.0.0.0'), { mode: 0o600 })
  const result = await ensureDedicated(root, {
    chromium: { name: 'fake', executable: join(root, 'must-not-launch') },
    url: 'about:blank',
  })
  assert.deepEqual({ endpoint: result.endpoint, launched: result.launched }, { endpoint: `http://127.0.0.1:${port}`, launched: false })
})

test('a fingerprint mismatch is treated as a foreign port, not our browser', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lwb-cdp-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { ensureDedicated, formatPortFile } = await import('../pack-browser.mjs')
  const port = await fakeChrome(t, { browser: 'Chrome/999.0.0.0' })
  await mkdir(join(root, 'profile'), { recursive: true })
  await writeFile(join(root, 'cdp-port'), formatPortFile(port, 'Chrome/131.0.0.0'), { mode: 0o600 })
  // 无可启动的浏览器 + 50ms 等待：不匹配时必须走“重新拉起”而非复用。
  await assert.rejects(ensureDedicated(root, {
    chromium: { name: 'fake', executable: join(root, 'must-not-launch') },
    url: 'about:blank',
    launchWaitMs: 50,
  }), /没有在 .* 秒内打开调试端口|没有找到/u)
})

test('a plain HTTP service on the recorded port is not mistaken for the browser', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lwb-cdp-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { ensureDedicated, formatPortFile } = await import('../pack-browser.mjs')
  const port = await fakeChrome(t, { versionPath: '/nothing' }) // 404 everywhere
  await mkdir(join(root, 'profile'), { recursive: true })
  await writeFile(join(root, 'cdp-port'), formatPortFile(port, 'Chrome/131.0.0.0'), { mode: 0o600 })
  await assert.rejects(ensureDedicated(root, {
    chromium: { name: 'fake', executable: join(root, 'must-not-launch') },
    url: 'about:blank',
    launchWaitMs: 50,
  }), /没有在 .* 秒内打开调试端口/u)
})
