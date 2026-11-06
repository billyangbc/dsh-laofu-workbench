import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// LWB_RUNTIME freezes the workspace packs directory at first module load, so
// this file relocates it before anything imports the pack manager.
const temporary = await mkdtemp(join(tmpdir(), 'lwb-pack-conflict-'))
const packs = join(temporary, 'packs')
await mkdir(packs, { recursive: true })
for (const name of ['copy-one', 'copy-two']) {
  const source = join(packs, name)
  await mkdir(source, { recursive: true })
  const manifest = { schemaVersion: 1, id: 'dup-pack', packageName: '@example/lwb-dup-pack', name: 'dup', version: '0.1.0', description: 'dup', menus: [{ id: 'home', label: 'Home', glyph: 'H', tone: 'blue' }] }
  await writeFile(join(source, 'lwb-pack.json'), `${JSON.stringify(manifest)}\n`)
  await writeFile(join(source, 'package.json'), `${JSON.stringify({ name: '@example/lwb-dup-pack', version: '0.1.0', type: 'module', exports: { '.': './index.mjs', './client': './client.js' }, dsh: { client: { platform: 'web' } } })}\n`)
  await writeFile(join(source, 'index.mjs'), 'export function apply() {}\n')
  await writeFile(join(source, 'client.js'), 'export const apply = () => {}\n')
}
process.env.LWB_PACKS_DIR = packs
process.env.LWB_PACK_REGISTRY = join(temporary, 'packs.json')

test('two workspace directories claiming one pack id cannot break the marketplace', async (t) => {
  t.after(async () => { await rm(temporary, { recursive: true, force: true }) })
  const manager = await import('../pack-manager.mjs')
  const market = await manager.marketplaceLwbPacks()
  const rows = market.filter((item) => item.manifest.id === 'dup-pack')
  assert.equal(rows.length, 1, `同一 id 只能呈现一行，实际 ${rows.length}`)
  assert.equal(rows[0].available, true, '市场不得因同 id 目录而失败或制造歧义行')
})

test('a failed registry rename leaves no temporary file behind', async () => {
  await mkdir(temporary, { recursive: true }) // the previous test's teardown removed it
  const blocked = join(temporary, 'blocked-registry.json')
  await mkdir(blocked) // rename onto a directory fails; the temp file used to stay
  process.env.LWB_PACK_REGISTRY = blocked
  const manager = await import(`../pack-manager.mjs?w=${Math.random()}`)
  await assert.rejects(manager.writeRegistry({ schemaVersion: 2, packs: [] }))
  const entries = await (await import('node:fs/promises')).readdir(temporary)
  assert.equal(entries.filter((name) => name.includes('blocked-registry.json') && name.endsWith('.tmp')).length, 0, '失败的写入不得残留 .tmp 文件')
})
