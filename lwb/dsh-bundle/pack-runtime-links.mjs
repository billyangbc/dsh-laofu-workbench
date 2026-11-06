import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, readlink, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LWB_RUNTIME, lwbProfilePath } from './runtime-config.mjs'
import { dshPackageDirectory } from './dsh-adapter/package-paths.mjs'
import { marketplaceLwbPacks } from './pack-manager.mjs'

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

function packagePath(nodeModules, packageName) {
  const segments = packageName.split('/')
  return packageName.startsWith('@') ? join(nodeModules, segments[0], segments[1]) : join(nodeModules, packageName)
}

export async function ensureLwbRuntimeSymlink(linkPath, target) {
  await mkdir(dirname(linkPath), { recursive: true })
  const stats = await lstat(linkPath).catch(error => { if (error.code !== 'ENOENT') throw error })
  if (stats) {
    if (!stats.isSymbolicLink()) throw new Error(`LWB profile path is not a symlink: ${linkPath}`)
    if (resolve(dirname(linkPath), await readlink(linkPath)) === resolve(target)) return
    await unlink(linkPath)
  }
  await symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
}

function runtimePackPath(pack) {
  const root = LWB_RUNTIME.packRuntimeDir
  if (root === undefined) return undefined
  const id = pack?.manifest?.id
  if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{1,62}$/u.test(id)) {
    throw new Error('Cannot materialize an LWB pack with an invalid id.')
  }
  return join(root, id)
}

const SOURCE_DIGEST_FILE = '.lwb-source-digest'
const copyFilter = (source) => !source.endsWith(`${sep}node_modules`) && !source.includes(`${sep}node_modules${sep}`)

/** Digest of the shipped part of a pack source tree, node_modules excluded. */
async function sourceDigest(root) {
  const digest = createHash('sha256')
  const walk = async directory => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (!copyFilter(path)) continue
      const key = path.slice(root.length + 1)
      if (entry.isSymbolicLink()) digest.update(`link:${key}\u0000${await readlink(path)}\u0000`)
      else if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) { digest.update(`file:${key}\u0000`); digest.update(await readFile(path)); digest.update('\u0000') }
    }
  }
  await walk(root)
  return digest.digest('hex')
}

/**
 * Copy a capability pack into the writable product area when its source is
 * shipped inside an immutable Desktop application resource tree. The copy is
 * intentionally code-only; durable pack data remains in the pack workspace.
 */
async function preparePackSource(pack) {
  const target = runtimePackPath(pack)
  if (target === undefined || resolve(target) === resolve(pack.source)) return pack.source
  const existingTarget = await realpath(target).catch(error => { if (error.code !== 'ENOENT') throw error })
  if (existingTarget === await realpath(pack.source)) return target
  /* The copied tree used to be rebuilt (rm + recursive cp) on every mount,
     which made each activation re-copy the whole pack. Keep the copy for as
     long as the source digest says nothing shipped has changed. */
  const digest = await sourceDigest(pack.source)
  const recorded = (await readFile(join(target, SOURCE_DIGEST_FILE), 'utf8').catch(() => '')).trim()
  if (recorded === digest) return target
  await mkdir(dirname(target), { recursive: true })
  await rm(target, { recursive: true, force: true })
  await cp(pack.source, target, { recursive: true, dereference: false, filter: copyFilter })
  // Recorded only after a complete copy: a torn copy must look stale next time.
  await writeFile(join(target, SOURCE_DIGEST_FILE), `${digest}\n`)
  return target
}

/** Make a locally registered package resolvable by the active DSH Profile. */
export async function linkLwbPackForRuntime(pack, profileDir = lwbProfilePath()) {
  if (!pack?.source || !pack?.manifest?.packageName) throw new Error('Cannot link an invalid LWB pack for runtime use.')
  const source = await preparePackSource(pack)
  const profileNodeModules = join(profileDir, 'node_modules')
  await mkdir(profileNodeModules, { recursive: true })
  await ensureLwbRuntimeSymlink(packagePath(profileNodeModules, pack.manifest.packageName), source)

  const packageJson = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  const declared = Object.assign({}, packageJson.dependencies, packageJson.peerDependencies)
  const packageNodeModules = join(source, 'node_modules')
  for (const name of Object.keys(declared)) {
    const target = name === '@scitiger-ai/lwb-pack-sdk'
      ? join(ROOT_DIR, 'lwb', 'pack-sdk')
      : name.startsWith('@deepseek-ai/') ? dshPackageDirectory(name) : undefined
    if (target) await ensureLwbRuntimeSymlink(packagePath(packageNodeModules, name), target)
  }
}

/** Update existing pack links before starting a host with immutable path caches. */
export async function prepareLwbPackRuntimeLinks(profileDir = lwbProfilePath()) {
  for (const pack of await marketplaceLwbPacks()) {
    if (!pack.available) continue
    const link = packagePath(join(profileDir, 'node_modules'), pack.manifest.packageName)
    const stats = await lstat(link).catch(error => { if (error.code !== 'ENOENT') throw error })
    if (stats?.isSymbolicLink()) await linkLwbPackForRuntime(pack, profileDir)
  }
}
