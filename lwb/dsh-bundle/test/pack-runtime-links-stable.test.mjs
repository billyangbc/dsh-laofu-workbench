import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// LWB_RUNTIME freezes the runtime packs dir at first load; this file owns a
// fresh process so the relocation below is what the module actually sees.
const root = await mkdtemp(join(tmpdir(), 'lwb-pack-runtime-links-stable-'))
process.env.LWB_DSH_HOME = join(root, 'dsh-home')
process.env.LWB_PACK_RUNTIME_DIR = join(root, 'runtime-packs')

test('an unchanged Desktop pack source is not re-copied on every activation', async (t) => {
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  await mkdir(source, { recursive: true })
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: '@example/stable-pack', version: '1.0.0' }))
  await writeFile(join(source, 'index.mjs'), 'export const version = 1\n')
  const { linkLwbPackForRuntime } = await import('../pack-runtime-links.mjs')
  const pack = { source, manifest: { id: 'stable-pack', packageName: '@example/stable-pack' } }
  await linkLwbPackForRuntime(pack)
  const target = join(root, 'runtime-packs', 'stable-pack', 'index.mjs')
  const first = await lstat(target)
  await new Promise(resolve => setTimeout(resolve, 20))
  await linkLwbPackForRuntime(pack)
  const second = await lstat(target)
  assert.equal(second.ino, first.ino, '源未变时不得整目录重拷（每次挂载都 rm+cp 是纯 IO 浪费）')
  /* 源变了必须重拷，短路不得掩盖更新。 */
  await writeFile(join(source, 'index.mjs'), 'export const version = 2\n')
  await linkLwbPackForRuntime(pack)
  const copied = await readFile(target, 'utf8')
  assert.match(copied, /version = 2/u)
})
