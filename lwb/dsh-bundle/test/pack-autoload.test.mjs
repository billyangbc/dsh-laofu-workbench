import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

async function createPack(rootDir, id, packageName) {
  const source = join(rootDir, id)
  const manifest = {
    schemaVersion: 1,
    id,
    packageName,
    name: id,
    version: '0.1.0',
    description: `${id} test pack`,
    menus: [{ id: 'home', label: 'Home', glyph: 'H', tone: 'blue' }],
  }
  await mkdir(source, { recursive: true })
  await writeFile(join(source, 'lwb-pack.json'), `${JSON.stringify(manifest)}\n`)
  await writeFile(join(source, 'package.json'), `${JSON.stringify({
    name: packageName,
    version: '0.1.0',
    type: 'module',
    exports: { '.': './index.mjs', './client': './client.js' },
    dsh: { client: { platform: 'web' } },
  })}\n`)
  await writeFile(join(source, 'index.mjs'), 'export function apply() {}\n')
  await writeFile(join(source, 'client.js'), 'export const apply = () => {}\n')
  return { manifest, source }
}

function runtimeContext(manifests) {
  const mounted = new Map()
  const entries = []
  const byId = new Map()
  const errors = []
  let sequence = 0
  const ctx = {
    lwbPackRegistry: { list: () => [...mounted.values()] },
    clientModules: {
      graph: () => ({
        entries: entries.length
          ? [...manifests.values()].map((manifest) => ({
            id: manifest.packageName,
            url: `plugins/${encodeURIComponent(manifest.packageName)}?rev=test`,
            rev: 'test',
            inject: [],
            external: [],
          }))
          : [],
      }),
    },
    loader: {
      entries: () => entries,
      create: async (options) => {
        const id = `entry-${++sequence}`
        const manifest = [...manifests.values()].find((candidate) => candidate.packageName === options.name)
        const entry = {
          id,
          options,
          fiber: {
            await: async () => {
              if (options.config?.clientOnly !== true && manifest) mounted.set(manifest.id, manifest)
            },
          },
        }
        entries.push(entry)
        byId.set(id, entry)
        return id
      },
      resolve: (id) => byId.get(id),
      remove: async (id) => {
        const entry = byId.get(id)
        if (entry?.options.config?.clientOnly !== true) {
          const manifest = [...manifests.values()].find((item) => item.packageName === entry?.options.name)
          if (manifest) mounted.delete(manifest.id)
        }
        const index = entries.findIndex((entry) => entry.id === id)
        if (index >= 0) entries.splice(index, 1)
        byId.delete(id)
      },
    },
    logger: { error: (value) => errors.push(String(value)) },
  }
  return { ctx, entries, errors }
}

test('only workbench-loaded packs are enabled and restored at startup', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'lwb-pack-autoload-'))
  const previousRegistry = process.env.LWB_PACK_REGISTRY
  const previousHome = process.env.LWB_DSH_HOME
  process.env.LWB_PACK_REGISTRY = join(temporary, 'packs.json')
  process.env.LWB_DSH_HOME = join(temporary, 'dsh-home')
  t.after(async () => {
    restoreEnv('LWB_PACK_REGISTRY', previousRegistry)
    restoreEnv('LWB_DSH_HOME', previousHome)
    await rm(temporary, { recursive: true, force: true })
  })

  const live = await createPack(temporary, 'live-pack', '@example/lwb-live-pack')
  const broken = await createPack(temporary, 'broken-pack', '@example/lwb-broken-pack')
  const moduleTag = encodeURIComponent(`${Date.now()}-${Math.random()}`)
  const manager = await import(`../../pack-manager.mjs?autoload=${moduleTag}`)
  const { LwbPackRuntime } = await import(`../pack-runtime.mjs?autoload=${moduleTag}`)

  await manager.installLwbPack(live.source)
  assert.equal((await manager.installedLwbPacks())[0].enabled, false, 'CLI registration must not enable startup loading')

  await manager.loadMarketplaceLwbPack(live.manifest.id)
  await manager.installLwbPack(broken.source, { enabled: true })
  await rm(broken.source, { recursive: true, force: true })

  const harness = runtimeContext(new Map([[live.manifest.id, live.manifest], [broken.manifest.id, broken.manifest]]))
  const runtime = new LwbPackRuntime(harness.ctx)
  runtime.driver.refreshResolution = async () => {}
  runtime.driver.importPackage = async () => {}
  const restored = await runtime.restore()

  assert.deepEqual(restored.loaded.map((item) => item.id), [live.manifest.id])
  assert.deepEqual(restored.failed.map((item) => item.id), [broken.manifest.id])
  assert.equal(harness.entries.filter((entry) => entry.options.name === live.manifest.packageName).length, 2)
  assert.equal(harness.entries.some((entry) => entry.options.name === broken.manifest.packageName), false)
  assert.equal(harness.errors.length, 1)

  const market = await runtime.market()
  const brokenRow = market.packs.find((item) => item.id === broken.manifest.id)
  assert.match(brokenRow.error, /does not exist/u)

  const registry = JSON.parse(await readFile(process.env.LWB_PACK_REGISTRY, 'utf8'))
  assert.equal(registry.packs.find((item) => item.id === live.manifest.id).enabled, true)
  assert.equal(registry.packs.find((item) => item.id === broken.manifest.id).enabled, true, 'a failed startup restore must remain eligible for retry')

  await runtime.unload({ id: live.manifest.id })
  const reloaded = await runtime.load({ id: live.manifest.id })
  assert.equal(reloaded.status, 'loaded', 'explicit market loading must retain source availability after registration')
  assert.equal(harness.entries.filter((entry) => entry.options.name === live.manifest.packageName).length, 2)

  await writeFile(process.env.LWB_PACK_REGISTRY, JSON.stringify({ schemaVersion: 1, packs: [] }))
  await assert.rejects(manager.marketplaceLwbPacks(), /schemaVersion must be 2/u)
})

test('spoken-video pins DSH peers to the supported release and declares the LWB SDK', async () => {
  const packageJson = JSON.parse(await readFile(join(root, 'lwb', 'packs', 'spoken-video', 'package.json'), 'utf8'))
  const lock = JSON.parse(await readFile(join(root, 'lwb', 'UPSTREAM.lock.json'), 'utf8'))
  for (const [name, version] of Object.entries(packageJson.peerDependencies)) {
    if (name.startsWith('@deepseek-ai/dsh-')) assert.equal(version, lock.tag.replace('dsh-v', ''))
  }
  assert.equal(packageJson.peerDependencies['@scitiger-ai/lwb-pack-sdk'], '0.1.0')
})

