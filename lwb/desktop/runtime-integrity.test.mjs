import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { recordRuntimeIntegrity, runtimeIntegrityFailure } from './runtime-integrity.mjs'

async function runtimeFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'lwb-runtime-integrity-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'lwb', 'dsh-bundle'), { recursive: true })
  await mkdir(join(root, 'lwb', 'packs', 'demo'), { recursive: true })
  await writeFile(join(root, 'build.json'), '{"id":"abc"}\n')
  await writeFile(join(root, 'lwb', 'dsh-bundle', 'index.mjs'), 'export const a = 1\n')
  await writeFile(join(root, 'lwb', 'packs', 'demo', 'index.mjs'), 'export const demo = 1\n')
  return root
}

test('a runtime copy verifies against the integrity record taken at install', async (t) => {
  const root = await runtimeFixture(t)
  await recordRuntimeIntegrity(root)
  assert.equal(await runtimeIntegrityFailure(root), null, '刚记录的副本必须通过')
  assert.equal(await runtimeIntegrityFailure(join(root, 'missing')), 'missing integrity record', '无记录的副本需重建')
})

test('tampering with shipped code is detected, including pack code', async (t) => {
  const root = await runtimeFixture(t)
  await recordRuntimeIntegrity(root)
  /* 模型或本地进程改写 pack 代码后，下次启动必须发现并重建副本。 */
  await writeFile(join(root, 'lwb', 'packs', 'demo', 'index.mjs'), 'export const demo = 2 // tampered\n')
  const failure = await runtimeIntegrityFailure(root)
  assert.match(String(failure), /lwb\/packs\/demo\/index\.mjs/u, `应指出被改动的文件，实际 ${failure}`)
})

test('added or removed files also invalidate the record', async (t) => {
  const root = await runtimeFixture(t)
  await recordRuntimeIntegrity(root)
  await writeFile(join(root, 'lwb', 'packs', 'demo', 'extra.mjs'), 'export {}\n')
  assert.match(String(await runtimeIntegrityFailure(root)), /额外|缺失|不一致|extra/u)
})
