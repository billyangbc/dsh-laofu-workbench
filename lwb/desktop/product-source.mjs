/**
 * Provenance record of the product-source snapshot the Windows release runner
 * builds from.
 *
 * `.build/product-source.tar.gz` in the private commercial repository is the
 * only product source that runner sees, and `.build/inputs.json` records where
 * it came from. No tooling reads the record; it exists so a human can tell one
 * snapshot from another. Refresh only the fields a snapshot run can determine
 * and leave every other recorded release input untouched.
 */

/** Fields one snapshot run owns. */
export const SNAPSHOT_INPUT_FIELDS = ['productSnapshotCommit', 'productArchiveSha256', 'includesLocalTrackedChanges']

/**
 * Merge one snapshot's provenance into the recorded inputs.
 * @param current - recorded inputs, as read from disk.
 * @param update - what this run determined.
 * @param update.snapshotCommit - commit the archived product source came from.
 * @param update.archiveSha256 - SHA-256 of the archive this run wrote.
 * @param update.includesLocalTrackedChanges - whether uncommitted work entered the archive.
 * @returns a new record with the snapshot fields replaced and key order kept.
 */
export function mergeSnapshotInputs(current, update) {
  const merged = { ...current }
  const values = {
    productSnapshotCommit: update.snapshotCommit,
    productArchiveSha256: update.archiveSha256,
    includesLocalTrackedChanges: update.includesLocalTrackedChanges,
  }
  for (const field of SNAPSHOT_INPUT_FIELDS) merged[field] = values[field]
  return merged
}

/**
 * Whether a snapshot run would change anything.
 * @param current - recorded inputs, as read from disk.
 * @param update - what this run determined.
 * @returns true when the record and the archive are already current.
 */
export function snapshotIsCurrent(current, update) {
  return current?.productSnapshotCommit === update.snapshotCommit
    && current?.productArchiveSha256 === update.archiveSha256
    && current?.includesLocalTrackedChanges === update.includesLocalTrackedChanges
}

/** Field name to the JSON literal one snapshot run writes. */
function snapshotValues(update) {
  return {
    productSnapshotCommit: JSON.stringify(update.snapshotCommit),
    productArchiveSha256: JSON.stringify(update.archiveSha256),
    includesLocalTrackedChanges: String(update.includesLocalTrackedChanges),
  }
}

/**
 * Replace only the snapshot values in an existing record's text, so a refresh
 * leaves every other recorded release input, and its formatting, byte-identical.
 * @param text - the record as read from disk.
 * @param update - what this run determined.
 * @returns the updated text, or undefined when the record cannot be patched in place.
 */
export function replaceSnapshotFields(text, update) {
  const values = snapshotValues(update)
  let patched = text
  for (const field of SNAPSHOT_INPUT_FIELDS) {
    const pattern = new RegExp(`("${field}"\\s*:\\s*)(?:"[^"]*"|true|false)`, 'u')
    if (!pattern.test(patched)) return undefined
    patched = patched.replace(pattern, `$1${values[field]}`)
  }
  return patched
}

/**
 * Serialise a record for a destination that has none yet.
 * @param current - recorded inputs, or undefined.
 * @param update - what this run determined.
 * @returns file text.
 */
export function serialiseSnapshotInputs(current, update) {
  return `${JSON.stringify(mergeSnapshotInputs(current ?? {}, update), null, 2)}\n`
}

/**
 * Why publishing the Windows leg from this snapshot record would be wrong, or
 * null when the record matches the checkout being released.
 *
 * The Windows artifact is built by the private runner from
 * `.build/product-source.tar.gz`, never from this repository. Publishing it
 * beside mac artifacts of one version while the snapshot came from another
 * commit ships two different codebases under the same version number; an
 * archive built with uncommitted tracked changes is just as unreproducible.
 * @param record - `.build/inputs.json` contents, or null when unreadable.
 * @param head - commit this release is cut from.
 * @returns a human-readable problem, or null.
 */
export function snapshotProvenanceProblem(record, head) {
  if (!record || typeof record !== 'object') return 'inputs.json 缺少快照溯源字段（无法确认 Windows 腿的构建来源）。'
  if (typeof record.productSnapshotCommit !== 'string' || !record.productSnapshotCommit) return 'inputs.json 未记录 productSnapshotCommit。'
  if (record.productSnapshotCommit !== head) {
    return `产品源码快照过期：inputs.json 记录 ${record.productSnapshotCommit.slice(0, 12)}，当前检出于 ${String(head).slice(0, 12)}。请先执行 npm run snapshot:product 并重建 Windows 腿。`
  }
  if (record.includesLocalTrackedChanges === true) return '产品源码快照包含未提交的受跟踪改动，请从干净工作树重建快照。'
  return null
}
