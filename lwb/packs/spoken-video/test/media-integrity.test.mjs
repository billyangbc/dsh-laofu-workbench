import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SpokenVideoProjectStore } from '../spoken-video-store.mjs'
import { SpokenVideoMediaHost } from '../spoken-video-media-host.mjs'

function agent(cwd) { return { session: { header: { cwd } } } }

function credentialStore(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    async resolve(ref) { const value = values.get(ref); return value ? { value, source: 'file' } : undefined },
    async describe(ref) { return { configured: values.has(ref), source: values.has(ref) ? 'file' : undefined, writable: true } },
    async set(ref, value) { values.set(ref, value) },
    async unset(ref) { values.delete(ref) },
  }
}

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'lwb-spoken-video-integrity-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  return cwd
}

async function projectWithApprovedScript(currentAgent, store) {
  let project = await store.create(currentAgent, { title: '并发提交测试' })
  project = (await store.commit(currentAgent, { projectId: project.id, expectedRevision: project.revision, stage: 'topic', payload: { title: '并发提交测试' }, idempotencyKey: 'integrity-topic-0001' })).project
  project = (await store.commit(currentAgent, { projectId: project.id, expectedRevision: project.revision, stage: 'script', payload: { body: '这是用于并发提交测试的口播稿。' }, idempotencyKey: 'integrity-script-0001' })).project
  return store.approveScript(currentAgent, { projectId: project.id })
}

/**
 * Two submissions in one tick used to read the same runs.json and each append
 * their own copy; the last write won and the other run's record vanished while
 * its background chain kept executing (double billing, then "记录丢失").
 */
test('并发提交同一项目的媒体任务不丢记录', async (t) => {
  const cwd = await workspace(t)
  const store = new SpokenVideoProjectStore()
  const currentAgent = agent(cwd)
  const project = await projectWithApprovedScript(currentAgent, store)
  const host = new SpokenVideoMediaHost({
    projectsStore: store,
    credentials: credentialStore({ DASHSCOPE_API_KEY: 'sk-integrity' }),
    fetch: async () => { throw new Error('test upstream is unavailable') },
  })
  const request = { projectId: project.id, expectedRevision: project.revision, provider: 'bailian', rate: 1, volume: 1 }
  const [first, second] = await Promise.all([
    host.startVoiceover(currentAgent, request),
    host.startVoiceover(currentAgent, request),
  ])
  const submitted = [first, second].filter((item) => !item.reused)
  assert.ok(submitted.length >= 1, '至少一个提交应当新建任务')
  const stored = JSON.parse(await readFile(join(cwd, 'data', 'projects', project.id, 'media', 'runs.json'), 'utf8')).runs.map((run) => run.id)
  for (const item of submitted) {
    assert.ok(stored.includes(item.id), `提交 ${item.id} 的记录必须在 runs.json 中留得住；现存：${stored.join(', ')}`)
  }
  /* 记录还在的后台链也要能正常结算，而不是以「记录丢失」崩掉。 */
  for (const item of submitted) {
    const deadline = Date.now() + 20_000
    let run = null
    while (Date.now() < deadline) {
      run = (await host.operations(currentAgent, { projectId: project.id })).find((candidate) => candidate.id === item.id)
      if (run?.status === 'succeeded' || run?.status === 'failed') break
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
    }
    assert.ok(run && ['succeeded', 'failed'].includes(run.status), `提交 ${item.id} 的后台任务必须能结算`)
    assert.doesNotMatch(String(run?.error || ''), /记录丢失/u)
  }
})

/**
 * A corrupted task file inside the background chain used to escape as an
 * unhandled rejection (Node >=15 default: crash the host). The launch site
 * must keep a backstop so the failure is observable but contained.
 */
test('音频任务后台链的文件损坏不得变成 unhandled rejection', async (t) => {
  const rejections = []
  const onUnhandled = (reason) => rejections.push(String(reason?.message || reason))
  process.on('unhandledRejection', onUnhandled)
  t.after(() => process.off('unhandledRejection', onUnhandled))
  const cwd = await workspace(t)
  let release = null
  const gate = new Promise((resolvePromise) => { release = resolvePromise })
  const base = credentialStore({ DASHSCOPE_API_KEY: 'sk-integrity' })
  const host = new SpokenVideoMediaHost({
    projectsStore: { async list() { return [] } },
    credentials: { ...base, async resolve(ref) { await gate; return base.resolve(ref) } },
    fetch: async () => { throw new Error('test upstream is unavailable') },
  })
  const started = await host.startAudioTask(agent(cwd), { text: '用于验证后台链失败的文本。', provider: 'bailian' })
  assert.equal(started.status, 'queued')
  const file = join(cwd, 'data', 'audio-tasks.json')
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const stored = JSON.parse(await readFile(file, 'utf8'))
    if (stored.tasks.some((task) => task.id === started.id && task.status === 'running')) break
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
  }
  /* 任务已进入 running 且暂停在凭据准备处：此刻破坏记录文件，放开闸门后
     失败结算本身也会失败——这正是过去直接 rejection 的路径。生产 background
     是恒等函数且调用处 void，promise 无人持有，rejection 只能靠启动点兜底。 */
  await writeFile(file, '{ corrupted by test', 'utf8')
  release()
  for (let attempt = 0; attempt < 50 && rejections.length === 0; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
  }
  assert.equal(rejections.length, 0, `后台链不得以 unhandled rejection 泄漏：${rejections.join(' | ')}`)
})
