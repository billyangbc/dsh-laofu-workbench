/**
 * Integrity record for the writable runtime copy of a packaged build.
 *
 * `bootstrap.mjs` copies the shipped payload to `<productHome>/runtime/<id>`
 * once and then executes from that copy on every later start. The record
 * written here pins the shipped `lwb/` tree (product code and pack code) plus
 * `build.json`, so a local process or model-driven Agent that edits the copy
 * is detected at the next boot and the copy is rebuilt from the payload.
 * It is tamper-evidence for the local single-user threat model, not a signature.
 */
import { createHash } from 'node:crypto'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

export const INTEGRITY_FILE = 'runtime-integrity.json'

const RECORDED_ROOTS = ['lwb']
const RECORDED_FILES = ['build.json']
const SKIPPED = new Set(['node_modules', '.cache', '.git'])

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

async function walk(directory, relativeTo, files) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await walk(path, relativeTo, files)
    else if (entry.isFile()) files.push(relative(relativeTo, path).split(sep).join('/'))
  }
}

async function shippedFiles(root) {
  const files = []
  for (const entry of RECORDED_FILES) if (await stat(join(root, entry)).then(s => s.isFile()).catch(() => false)) files.push(entry)
  for (const entry of RECORDED_ROOTS) {
    if (await stat(join(root, entry)).then(s => s.isDirectory()).catch(() => false)) await walk(join(root, entry), root, files)
  }
  return files.sort()
}

/** Write the integrity record for one completed runtime copy. */
export async function recordRuntimeIntegrity(root) {
  const files = []
  for (const path of await shippedFiles(root)) {
    files.push({ path, sha256: sha256(await readFile(join(root, path))) })
  }
  await writeFile(join(root, INTEGRITY_FILE), `${JSON.stringify({ schemaVersion: 1, files }, null, 2)}\n`, { mode: 0o600 })
}

/**
 * What is wrong with this runtime copy, or null when it matches its record.
 * Every mismatch names the first offending path so a rebuild is explainable.
 * @param root - the runtime directory under `<productHome>/runtime/`.
 */
export async function runtimeIntegrityFailure(root) {
  let record
  try { record = JSON.parse(await readFile(join(root, INTEGRITY_FILE), 'utf8')) } catch { return 'missing integrity record' }
  if (!record || record.schemaVersion !== 1 || !Array.isArray(record.files)) return 'integrity record is unreadable'
  const expected = new Map(record.files.map(file => [file.path, file.sha256]))
  for (const file of record.files) {
    const actual = await readFile(join(root, file.path)).then(sha256, () => null)
    if (actual === null) return `运行时副本缺少 ${file.path}`
    if (actual !== file.sha256) return `运行时副本的 ${file.path} 与安装记录不一致`
  }
  for (const path of await shippedFiles(root)) {
    if (!expected.has(path)) return `运行时副本出现安装记录之外的文件 ${path}`
  }
  return null
}
