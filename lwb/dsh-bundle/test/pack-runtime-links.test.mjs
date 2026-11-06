import assert from 'node:assert/strict'
import { lstat, mkdtemp, mkdir, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('Desktop materializes read-only pack sources under the writable product home', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lwb-pack-runtime-links-'))
  const previous = {
    profile: process.env.LWB_PROFILE_ID,
    home: process.env.LWB_DSH_HOME,
    runtime: process.env.LWB_PACK_RUNTIME_DIR,
  }
  process.env.LWB_PROFILE_ID = 'desktop'
  process.env.LWB_DSH_HOME = join(root, 'dsh-home')
  process.env.LWB_PACK_RUNTIME_DIR = join(root, 'runtime-packs')
  t.after(async () => {
    for (const [name, value] of Object.entries({
      LWB_PROFILE_ID: previous.profile,
      LWB_DSH_HOME: previous.home,
      LWB_PACK_RUNTIME_DIR: previous.runtime,
    })) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(root, { recursive: true, force: true })
  })

  const source = join(root, 'read-only-source')
  await mkdir(source, { recursive: true })
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: '@example/desktop-pack', version: '1.0.0' }))
  await writeFile(join(source, 'index.mjs'), 'export const source = true\n')

  const { linkLwbPackForRuntime } = await import(`../pack-runtime-links.mjs?test=${Date.now()}`)
  await linkLwbPackForRuntime({ source, manifest: { id: 'desktop-pack', packageName: '@example/desktop-pack' } })

  const runtimeSource = join(root, 'runtime-packs', 'desktop-pack')
  assert.equal(await readlink(join(root, 'dsh-home', 'profiles', 'desktop', 'node_modules', '@example', 'desktop-pack')), runtimeSource)
  assert.equal(await lstat(join(runtimeSource, 'index.mjs')).then((stats) => stats.isFile()), true)
  assert.equal(await lstat(source).then((stats) => stats.isDirectory()), true)
})


