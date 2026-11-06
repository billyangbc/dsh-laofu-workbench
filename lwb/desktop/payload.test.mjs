import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { assembleProductPayload } from './payload.mjs'

async function temporaryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'lwb-payload-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

async function writeFileAt(root, path, contents = 'export default {}\n') {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), contents)
}

async function listFiles(root, prefix = '') {
  const files = []
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...await listFiles(join(root, entry.name), path))
    else files.push(path)
  }
  return files.sort()
}

/** A project with product paths, one owned pack, and a pack that is not listed. */
async function fixtureProject(t) {
  const root = await temporaryRoot(t)
  await writeFileAt(root, 'lwb/dsh-bundle/index.mjs')
  await writeFileAt(root, 'lwb/dsh-bundle/node_modules/dep/index.js')
  await writeFileAt(root, 'lwb/dsh-bundle/test/ignored.test.mjs')
  await writeFileAt(root, 'lwb/pack-sdk/index.mjs')
  await writeFileAt(root, 'lwb/profile-setup.mjs')
  await writeFileAt(root, 'lwb/packs/pack-one/index.mjs')
  await writeFileAt(root, 'lwb/packs/pack-one/client.js')
  await writeFileAt(root, 'lwb/packs/pack-one/node_modules/dep/index.js')
  await writeFileAt(root, 'lwb/packs/pack-one/test/ignored.test.mjs')
  await writeFileAt(root, 'lwb/packs/pack-one/.git/config')
  // A private pack checkout carries build bookkeeping, preview output and CI
  // workflows that the release runner archives without.
  await writeFileAt(root, 'lwb/packs/pack-one/.build/product-source.tar.gz')
  await writeFileAt(root, 'lwb/packs/pack-one/.build/inputs.json')
  await writeFileAt(root, 'lwb/packs/pack-one/.preview/out/index.html', '<!doctype html>\n')
  await writeFileAt(root, 'lwb/packs/pack-one/.github/workflows/test-build.yml', 'name: test\n')
  // Present on disk but absent from the edition: it must not ship.
  await writeFileAt(root, 'lwb/packs/secret-pack/lwb-pack.json')
  await writeFileAt(root, 'lwb/packs/secret-pack/index.mjs')
  return root
}

test('only the listed edition packs reach the payload', async (t) => {
  const root = await fixtureProject(t)
  const payload = join(root, 'payload')
  await assembleProductPayload({
    projectRoot: root,
    edition: { packs: [{ id: 'pack-one', source: join(root, 'lwb', 'packs', 'pack-one') }] },
    payload,
  })
  assert.deepEqual(await listFiles(payload), [
    'lwb/dsh-bundle/index.mjs',
    'lwb/pack-sdk/index.mjs',
    'lwb/packs/pack-one/client.js',
    'lwb/packs/pack-one/index.mjs',
    'lwb/profile-setup.mjs',
  ])
})

test('dependencies, test trees, repository metadata and build residue never ship', async (t) => {
  const root = await fixtureProject(t)
  const payload = join(root, 'payload')
  await assembleProductPayload({
    projectRoot: root,
    edition: { packs: [{ id: 'pack-one', source: join(root, 'lwb', 'packs', 'pack-one') }] },
    payload,
  })
  const files = await listFiles(payload)
  for (const excluded of ['node_modules', '/test/', '.git', '/.build/', '/.preview/', '/.github/']) {
    assert.ok(!files.some(file => file.includes(excluded)), `${excluded} must not ship, got ${files.join(', ')}`)
  }
})

test('a pack checked out elsewhere ships under its edition id', async (t) => {
  const root = await fixtureProject(t)
  const external = await temporaryRoot(t)
  await writeFileAt(external, 'lwb-pack.json')
  await writeFileAt(external, 'index.mjs')
  await writeFileAt(external, 'test/ignored.test.mjs')
  const payload = join(root, 'payload')
  const keys = []
  await assembleProductPayload({
    projectRoot: root,
    edition: { packs: [{ id: 'model-review', source: external }] },
    payload,
    onFile: (key) => { keys.push(key) },
  })
  assert.deepEqual(await listFiles(join(payload, 'lwb', 'packs', 'model-review')), ['index.mjs', 'lwb-pack.json'])
  assert.ok(keys.includes(join('packs', 'model-review', 'index.mjs')), `keys were ${keys.join(', ')}`)
  assert.ok(!keys.some(key => key.includes(external)), 'a build key must not embed the pack checkout location')
})

test('shipped keys are stable no matter where the pack is checked out', async (t) => {
  const first = await fixtureProject(t)
  const second = await fixtureProject(t)
  const keysOf = async (root) => {
    const keys = []
    await assembleProductPayload({
      projectRoot: root,
      edition: { packs: [{ id: 'pack-one', source: join(root, 'lwb', 'packs', 'pack-one') }] },
      payload: join(root, 'payload'),
      onFile: (key) => { keys.push(key) },
    })
    return keys.sort()
  }
  assert.deepEqual(await keysOf(first), await keysOf(second))
})
test('credential-like files never ship and every skip is reported', async (t) => {
  const root = await fixtureProject(t)
  // 仓库树或私有包 checkout 里可能存在的凭据形态：根 .env、变体、密钥材料、
  // 命名含 secret/credential 的文件与 .npmrc（可能带 registry token）。
  await writeFileAt(root, 'lwb/dsh-bundle/.env')
  await writeFileAt(root, 'lwb/dsh-bundle/.env.local')
  await writeFileAt(root, 'lwb/packs/pack-one/keys/server.pem')
  await writeFileAt(root, 'lwb/packs/pack-one/keys/server.key')
  await writeFileAt(root, 'lwb/packs/pack-one/secrets.json')
  await writeFileAt(root, 'lwb/packs/pack-one/.npmrc')
  const payload = join(root, 'payload')
  const result = await assembleProductPayload({
    projectRoot: root,
    edition: { packs: [{ id: 'pack-one', source: join(root, 'lwb', 'packs', 'pack-one') }] },
    payload,
  })
  const files = await listFiles(payload)
  for (const banned of ['.env', '.env.local', 'server.pem', 'server.key', 'secrets.json', '.npmrc']) {
    assert.ok(!files.some(file => file.endsWith(banned)), `${banned} must not ship, got ${files.join(', ')}`)
  }
  assert.ok(files.includes('lwb/packs/pack-one/index.mjs'), '正常业务文件仍然随包发行')
  const skipped = (result?.skipped || []).map(String).sort()
  assert.deepEqual(skipped, [
    'lwb/dsh-bundle/.env',
    'lwb/dsh-bundle/.env.local',
    'packs/pack-one/.npmrc',
    'packs/pack-one/keys/server.key',
    'packs/pack-one/keys/server.pem',
    'packs/pack-one/secrets.json',
  ], '每个被跳过的凭据文件都要以构建键出现在报告里，便于人工核对来源')
})
