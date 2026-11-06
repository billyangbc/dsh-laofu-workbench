import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SNAPSHOT_INPUT_FIELDS, mergeSnapshotInputs, replaceSnapshotFields, serialiseSnapshotInputs, snapshotIsCurrent,
} from './product-source.mjs'

/** The record shape the private repository keeps, with release inputs a snapshot run must not touch. */
function recorded() {
  return {
    productSnapshotCommit: 'b69beee9e0ed80ea03c8160913ee62839b97fae2',
    productBaseCommit: '57519042b145462c764f2cc114b99cdf1317cdc9',
    commercialBaseCommit: '235f8c41c88680e2667eb223af2b4951792e9027',
    includesLocalTrackedChanges: false,
    productArchiveSha256: '01283d2eccb48a60453c3368748dd90f12d7e15cde995131647938aa4a57fe72',
    mode: 'unsigned-release',
    buildHosts: { 'win-x64': 'self-hosted Windows X64', 'mac-arm64': 'local Apple Silicon Mac' },
    targets: ['win-x64', 'mac-arm64'],
    editions: ['commercial'],
  }
}

const UPDATE = {
  snapshotCommit: '7092f75f9a14e87cb0b49adc1b6c1bc23ca10eda',
  archiveSha256: 'f'.repeat(64),
  includesLocalTrackedChanges: false,
}

test('a snapshot run owns exactly its provenance fields', () => {
  const merged = mergeSnapshotInputs(recorded(), UPDATE)
  assert.equal(merged.productSnapshotCommit, UPDATE.snapshotCommit)
  assert.equal(merged.productArchiveSha256, UPDATE.archiveSha256)
  assert.equal(merged.includesLocalTrackedChanges, false)

  const untouched = Object.keys(recorded()).filter(key => !SNAPSHOT_INPUT_FIELDS.includes(key))
  for (const key of untouched) assert.deepEqual(merged[key], recorded()[key], `${key} is another release input's business`)
  assert.deepEqual(Object.keys(merged), Object.keys(recorded()), 'the record keeps its field order')
})

test('the merge never mutates the record it read', () => {
  const current = recorded()
  const merged = mergeSnapshotInputs(current, UPDATE)
  assert.notEqual(merged, current)
  assert.equal(current.productSnapshotCommit, 'b69beee9e0ed80ea03c8160913ee62839b97fae2')
})

test('a missing provenance field is added rather than dropped', () => {
  const merged = mergeSnapshotInputs({ mode: 'unsigned-release' }, UPDATE)
  assert.equal(merged.productSnapshotCommit, UPDATE.snapshotCommit)
  assert.equal(merged.productArchiveSha256, UPDATE.archiveSha256)
  assert.equal(merged.includesLocalTrackedChanges, false)
  assert.equal(merged.mode, 'unsigned-release')
})

test('an uncommitted-work snapshot records that it includes local changes', () => {
  const merged = mergeSnapshotInputs(recorded(), { ...UPDATE, includesLocalTrackedChanges: true })
  assert.equal(merged.includesLocalTrackedChanges, true)
})

test('an already current snapshot is recognised', () => {
  const current = mergeSnapshotInputs(recorded(), UPDATE)
  assert.equal(snapshotIsCurrent(current, UPDATE), true)
  assert.equal(snapshotIsCurrent(recorded(), UPDATE), false, 'a different recorded commit is not current')
  assert.equal(snapshotIsCurrent(undefined, UPDATE), false, 'a missing record is not current')
  assert.equal(snapshotIsCurrent(current, { ...UPDATE, archiveSha256: 'e'.repeat(64) }), false)
  assert.equal(snapshotIsCurrent(current, { ...UPDATE, includesLocalTrackedChanges: true }), false)
})

const RECORD_TEXT = `{
  "productSnapshotCommit": "b69beee9e0ed80ea03c8160913ee62839b97fae2",
  "productBaseCommit": "57519042b145462c764f2cc114b99cdf1317cdc9",
  "includesLocalTrackedChanges": false,
  "productArchiveSha256": "01283d2eccb48a60453c3368748dd90f12d7e15cde995131647938aa4a57fe72",
  "mode": "unsigned-release",
  "buildHosts": { "win-x64": "self-hosted Windows X64", "mac-arm64": "local Apple Silicon Mac" },
  "editions": ["commercial"]
}
`

test('refreshing a record patches its three values and nothing else', () => {
  const patched = replaceSnapshotFields(RECORD_TEXT, UPDATE)
  assert.ok(patched, 'a complete record is patched in place')
  assert.match(patched, /"productSnapshotCommit": "7092f75f9a14e87cb0b49adc1b6c1bc23ca10eda"/u)
  assert.match(patched, /"productArchiveSha256": "f{64}"/u)
  assert.match(patched, /"includesLocalTrackedChanges": false/u)
  assert.match(patched, /"buildHosts": \{ "win-x64": "self-hosted Windows X64", "mac-arm64": "local Apple Silicon Mac" \}/u,
    'another release input keeps its own formatting')
  assert.match(patched, /"editions": \["commercial"\]/u)
  const expected = RECORD_TEXT
    .replace(/"productSnapshotCommit": "[^"]*"/u, `"productSnapshotCommit": "${UPDATE.snapshotCommit}"`)
    .replace(/"productArchiveSha256": "[^"]*"/u, `"productArchiveSha256": "${UPDATE.archiveSha256}"`)
  assert.equal(patched, expected, 'nothing but the three values changed')

  const dirty = replaceSnapshotFields(RECORD_TEXT, { ...UPDATE, includesLocalTrackedChanges: true })
  assert.match(dirty, /"includesLocalTrackedChanges": true/u)
})

test('a record missing a field is reported instead of half-patched', () => {
  assert.equal(replaceSnapshotFields('{ "mode": "unsigned-release" }', UPDATE), undefined)
  assert.match(serialiseSnapshotInputs(undefined, UPDATE), /"productSnapshotCommit": "7092f75f9a14e87cb0b49adc1b6c1bc23ca10eda"/u)
  assert.match(serialiseSnapshotInputs({ mode: 'unsigned-release' }, UPDATE), /"mode": "unsigned-release"/u)
})

test('the Windows leg refuses a stale or dirty product-source snapshot', async () => {
  const { snapshotProvenanceProblem } = await import('./product-source.mjs')
  const head = 'a'.repeat(40)
  assert.equal(snapshotProvenanceProblem({ productSnapshotCommit: head, includesLocalTrackedChanges: false }, head), null)
  assert.match(String(snapshotProvenanceProblem({ productSnapshotCommit: 'b'.repeat(40), includesLocalTrackedChanges: false }, head)), /过期/u)
  assert.match(String(snapshotProvenanceProblem({ productSnapshotCommit: head, includesLocalTrackedChanges: true }, head)), /未提交/u)
  assert.match(String(snapshotProvenanceProblem(null, head)), /缺少/u)
  assert.match(String(snapshotProvenanceProblem({}, head)), /未记录/u)
})
