import { executionEvent, executionTransition } from './spoken-video-execution.mjs'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { spokenVideoDataPath } from './spoken-video-paths.mjs'
import {
  buildPublishPrompt,
  extractPublishImageUrl,
  imageTaskId,
  imageTaskState,
  inspectPublishImage,
  normalizePublishResult,
  PUBLISH_PACKAGE_SCHEMA,
  publishImageConfig,
  publishImageCredentialRef,
  publishImageRequest,
  SpokenVideoPublishError,
} from './spoken-video-publish.mjs'
import { appendDshTrace, dshChildStarted, dshTrace, ensureDshTrace, projectDshSessionEvent } from './spoken-video-dsh-trace.mjs'

const PROJECT_ID = /^[a-f0-9-]{36}$/iu
const TASKS_FILE = 'publish-tasks.json'
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_ASSET_BYTES = 80 * 1024 * 1024
const execFileAsync = promisify(execFile)

function fail(code, message) { throw new SpokenVideoPublishError(code, message) }
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('SPOKEN_VIDEO_PUBLISH_INVALID_INPUT', `${label}必须是对象。`)
  return value
}
function text(value, label, maximum) {
  if (typeof value !== 'string') fail('SPOKEN_VIDEO_PUBLISH_INVALID_INPUT', `${label}必须是文本。`)
  const result = value.trim()
  if (!result || result.length > maximum) fail('SPOKEN_VIDEO_PUBLISH_INVALID_INPUT', `${label}长度必须在 1-${maximum} 之间。`)
  return result
}
function projectId(value) {
  const result = text(value, '项目标识', 36).toLowerCase()
  if (!PROJECT_ID.test(result)) fail('SPOKEN_VIDEO_PUBLISH_INVALID_INPUT', '项目标识无效。')
  return result
}
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail('SPOKEN_VIDEO_PUBLISH_INVALID_INPUT', '项目版本无效。')
  return value
}
function base64(value) {
  if (typeof value !== 'string' || !value.length || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    fail('SPOKEN_VIDEO_PUBLISH_INVALID_INPUT', '封面内容不是有效 Base64。')
  }
  const bytes = Buffer.from(value, 'base64')
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== value) {
    fail(bytes.length > MAX_IMAGE_BYTES ? 'SPOKEN_VIDEO_PUBLISH_FILE_TOO_LARGE' : 'SPOKEN_VIDEO_PUBLISH_INVALID_INPUT', bytes.length > MAX_IMAGE_BYTES ? '封面不能超过 20 MiB。' : '封面内容不是规范 Base64。')
  }
  return bytes
}
function pathInside(root, target) {
  const value = relative(root, target)
  return value !== '' && value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value)
}
async function workspaceFor(agent) {
  const cwd = agent?.workspacePath ?? agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) fail('SPOKEN_VIDEO_WORKSPACE_REQUIRED', '发布任务需要已加载的能力包专属工作区。')
  try {
    const workspace = await realpath(cwd)
    const info = await lstat(workspace)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('invalid')
    return workspace
  } catch { fail('SPOKEN_VIDEO_WORKSPACE_REQUIRED', '能力包专属工作区不可用，请重新加载能力包后重试。') }
}
async function publishRootFor(agent) {
  const workspace = await workspaceFor(agent)
  const root = spokenVideoDataPath(workspace)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const info = await lstat(root)
  if (!info.isDirectory() || info.isSymbolicLink()) fail('SPOKEN_VIDEO_PUBLISH_FILE_INVALID', '发布任务目录无效。')
  return realpath(root)
}
async function projectRootFor(agent, id) {
  const root = join(await publishRootFor(agent), 'projects', id)
  const info = await lstat(root).catch(() => null)
  if (!info?.isDirectory() || info.isSymbolicLink()) fail('SPOKEN_VIDEO_NOT_FOUND', '口播项目不存在。')
  return realpath(root)
}
async function safeTarget(root, file, createParent = false) {
  if (!/^media\/(?:publish-covers|videos)\/[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/u.test(file)) fail('SPOKEN_VIDEO_PUBLISH_FILE_INVALID', '发布媒体路径无效。')
  const target = resolve(root, file)
  if (!pathInside(root, target)) fail('SPOKEN_VIDEO_PUBLISH_FILE_INVALID', '发布媒体路径越界。')
  if (createParent) await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  const parent = await realpath(dirname(target))
  if (!pathInside(root, parent)) fail('SPOKEN_VIDEO_PUBLISH_FILE_INVALID', '发布媒体目录越界。')
  const existing = await lstat(target).catch(() => null)
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) fail('SPOKEN_VIDEO_PUBLISH_FILE_INVALID', '发布媒体文件无效。')
  return target
}
async function readTasks(root) {
  const file = join(root, TASKS_FILE)
  const info = await lstat(file).catch(() => null)
  if (!info) return { schemaVersion: 1, tasks: [] }
  if (!info.isFile() || info.isSymbolicLink()) fail('SPOKEN_VIDEO_PUBLISH_FILE_INVALID', '发布任务文件无效。')
  try {
    const value = JSON.parse(await readFile(file, 'utf8'))
    return { schemaVersion: 1, tasks: Array.isArray(value?.tasks) ? value.tasks.slice(0, 240) : [] }
  } catch { fail('SPOKEN_VIDEO_PUBLISH_FILE_INVALID', '发布任务文件不是有效 JSON。') }
}
async function writeTasks(root, data) {
  const target = join(root, TASKS_FILE)
  const temporary = join(root, `.${randomUUID()}.publish.tmp`)
  await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, tasks: data.tasks.slice(0, 240) }, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  await rename(temporary, target)
}
function contentInput(value) {
  const input = object(value, '发布内容')
  const tags = Array.isArray(input.tags) ? [...new Set(input.tags.map((tag) => text(tag, '发布标签', 30).replace(/^#/u, '')))].slice(0, 10) : []
  if (!tags.length) fail('SPOKEN_VIDEO_PUBLISH_INVALID_INPUT', '至少需要一个发布标签。')
  return { title: text(input.title, '发布标题', 80), copy: text(input.copy, '视频文案', 2000), description: text(input.description, '视频描述', 1000), tags }
}
function promptsInput(value, current) {
  if (value === undefined || value === null) return current
  const input = object(value, '封面提示词')
  return {
    landscape: text(input.landscape ?? current.landscape, '横屏封面提示词', 3000),
    portrait: text(input.portrait ?? current.portrait, '竖屏封面提示词', 3000),
    negative: typeof input.negative === 'string' ? input.negative.slice(0, 1000) : (current.negative || ''),
  }
}
function taskSummary(task) {
  return { id: task.id, projectId: task.projectId, projectTitle: task.projectTitle, account: task.account || null, status: task.status, phase: task.phase || null, coverKind: task.coverKind || null, error: task.error || null, createdAt: task.createdAt, updatedAt: task.updatedAt, completedAt: task.completedAt || null, imageProvider: task.imageProvider || null, coverErrors: task.coverErrors || {}, dsh: task.dsh || dshTrace() }
}
function boundedUrl(value, label) {
  let url
  try { url = new URL(String(value || '').trim()) } catch { fail('SPOKEN_VIDEO_PUBLISH_SERVICE_FAILED', `${label}返回的地址无效。`) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('SPOKEN_VIDEO_PUBLISH_SERVICE_FAILED', `${label}返回的地址无效。`)
  return url
}

export class SpokenVideoPublishHost {
  constructor({ background = (work) => work, projectsStore, credentials, account, connectionSettings, packageExecutor, fetch = globalThis.fetch, environment = process.env, pollIntervalMs = 1500, maxPollMs = 15 * 60 * 1000 } = {}) {
    if (!projectsStore) throw new Error('SpokenVideoPublishHost requires projectsStore.')
    this.background = background
    this.projectsStore = projectsStore
    this.account = account
    this.credentials = credentials || null
    this.connectionSettings = connectionSettings || null
    this.packageExecutor = typeof packageExecutor === 'function' ? packageExecutor : null
    this.fetch = fetch
    this.environment = environment
    this.pollIntervalMs = pollIntervalMs
    this.maxPollMs = maxPollMs
    this.writes = new Map()
    this.thumbnails = new Map()
    this.thumbnailWorkers = [Promise.resolve(), Promise.resolve()]
    this.thumbnailWorkerIndex = 0
    this.active = new Set()
  }

  async #serial(root, callback) {
    const previous = this.writes.get(root) || Promise.resolve()
    const result = previous.then(callback)
    const tail = result.catch(() => {})
    this.writes.set(root, tail)
    try { return await result } finally { if (this.writes.get(root) === tail) this.writes.delete(root) }
  }

  #credentials() {
    if (!this.credentials?.resolve) fail('SPOKEN_VIDEO_PUBLISH_CONNECTION_UNAVAILABLE', '当前环境不提供私有凭据服务。')
    return this.credentials
  }

  async #credentialStatus(provider) {
    if (!this.credentials?.describe) return { configured: false, source: null, writable: false }
    const status = await this.credentials.describe(publishImageCredentialRef(provider))
    return { configured: status?.configured === true, source: status?.source || null, writable: status?.writable === true }
  }

  async status() {
    const settings = this.connectionSettings?.get?.() || {}
    const provider = ['bailian', 'lwb'].includes(settings.provider) ? settings.provider : 'lwb'
    const providers = {
      bailian: { label: '百炼 BYOK', credential: await this.#credentialStatus('bailian') },
      lwb: { label: 'LWB 账号', credential: await this.account?.status('cover-image') || { configured: false, reason: '请先登录 LWB 账号。' } },
    }
    const configured = providers[provider].credential.configured === true
    return {
      // `enabled` remains as a compatibility alias for existing consumers. A
      // saved credential is now the single source of truth for availability.
      enabled: configured,
      configured,
      provider,
      model: provider === 'lwb' ? 'LWB 托管' : typeof settings.model === 'string' && settings.model.trim() ? settings.model.trim() : publishImageConfig(this.environment).model,
      providers,
      imageMaxBytes: MAX_IMAGE_BYTES,
    }
  }

  async configureConnection(request) {
    const input = object(request, '生图配置')
    const provider = text(input.provider || 'lwb', '生图渠道', 40).toLowerCase()
    const ref = provider === 'lwb' ? null : publishImageCredentialRef(provider)
    if (provider === 'lwb' && (input.apiKey || input.model)) fail('SPOKEN_VIDEO_PUBLISH_INVALID_INPUT', 'LWB 服务的模型与凭据由账号管理。')
    const apiKey = typeof input.apiKey === 'string' && input.apiKey.trim() ? text(input.apiKey, 'API Key', 512) : null
    if (!this.connectionSettings?.update) fail('SPOKEN_VIDEO_PUBLISH_CONNECTION_UNAVAILABLE', '当前环境不支持保存生图设置。')
    if (apiKey && ref) await this.#credentials().set(ref, apiKey)
    await this.connectionSettings.update(provider === 'lwb' ? { provider } : { provider, model: text(input.model || publishImageConfig(this.environment).model, '生图模型', 120) })
    return this.status()
  }

  async clearConnectionCredential(request) {
    const provider = text(object(request, '生图配置').provider, '生图渠道', 40).toLowerCase()
    await this.#credentials().unset(publishImageCredentialRef(provider))
    return this.status()
  }

  /**
   * The publish page is a flat video shelf grouped by account: every project
   * whose technical qc passed shows up, whether or not publish info exists yet.
   */
  async listItems(agent, request = {}) {
    const input = object(request, '发布列表请求')
    const accountId = typeof input.accountId === 'string' && input.accountId.trim() ? projectId(input.accountId) : null
    const generalOnly = input.general === true
    const root = await publishRootFor(agent)
    const tasks = await this.#recoverInterrupted(root)
    const latest = new Map()
    for (const task of [...tasks].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))) if (!latest.has(task.projectId)) latest.set(task.projectId, task)
    const projects = await this.projectsStore.list(agent)
    const eligible = projects.filter((project) => project.completedStages.includes('qc'))
      .filter((project) => !accountId || project.account?.id === accountId)
      .filter((project) => !generalOnly || !project.account)
    const items = []
    for (const project of eligible) {
      const task = latest.get(project.id) || null
      const detail = await this.projectsStore.get(agent, { projectId: project.id })
      // Decision C: the shelf only shows QC-passed final cuts; failed or
      // missing QC keeps the project on the video workbench instead.
      if (detail.artifacts?.qc?.data?.passed !== true) continue
      items.push({
        ...project,
        task: task ? taskSummary(task) : null,
        packaging: detail.artifacts?.packaging?.data || null,
        video: detail.artifacts?.video?.data?.video || null,
        orientation: detail.artifacts?.video?.data?.orientation || null,
        qcPassed: true,
      })
    }
    return { items: items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))), total: items.length }
  }

  async startPackaging(agent, request) {
    const input = object(request, '发布包装任务请求')
    const id = projectId(input.projectId)
    const expectedRevision = revision(input.expectedRevision)
    const detail = await this.projectsStore.get(agent, { projectId: id })
    if (detail.revision !== expectedRevision) fail('SPOKEN_VIDEO_REVISION_CONFLICT', '项目已更新，请刷新后重试。')
    if (detail.artifacts?.qc?.data?.passed !== true) fail('SPOKEN_VIDEO_STAGE_BLOCKED', '只有质检通过的成片才能加入发布工作队列。')
    const root = await publishRootFor(agent)
    const settings = await this.status()
    const task = {
      id: randomUUID(), projectId: id, projectTitle: detail.title, account: detail.account || null,
      status: 'queued', phase: 'agent', error: null, expectedRevision, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null,
      sourceSnapshot: { script: detail.artifacts?.script?.data, topic: detail.artifacts?.topic?.data, video: detail.artifacts?.video?.data },
      imageProvider: settings.configured ? { provider: settings.provider, model: settings.model, ...(settings.provider === 'lwb' ? { lwbUserId: settings.providers.lwb.credential.userId } : {}) } : null, coverErrors: {},
      dsh: dshTrace(),
    }
    await this.#serial(root, async () => { const data = await readTasks(root); data.tasks.unshift(task); await writeTasks(root, data) })
    this.active.add(task.id)
    void this.background(this.#run(agent, root, task.id).finally(() => this.active.delete(task.id)))
    return taskSummary(task)
  }

  async task(agent, request) {
    const id = text(object(request, '发布任务请求').taskId, '发布任务标识', 64)
    const tasks = await this.#recoverInterrupted(await publishRootFor(agent))
    const task = tasks.find((item) => item.id === id)
    if (!task) fail('SPOKEN_VIDEO_NOT_FOUND', '发布任务不存在。')
    return taskSummary(task)
  }

  /**
   * Recover tasks left in a live state by a previous process. A restart drops
   * every in-flight agent run and cover poll, so they can never resume; mark
   * them failed once and let the user retry rather than showing a stuck task.
   */
  async #recoverInterrupted(root) {
    /* Read and write inside the same serial section: this fires from read
       paths, and a snapshot taken outside the lock used to roll back a status
       that a concurrent #mutateTask had just written. */
    return this.#serial(root, async () => {
      const data = await readTasks(root)
      let changed = false
      const now = new Date().toISOString()
      for (const task of data.tasks) {
        if (['queued', 'running'].includes(task.status) && !this.active.has(task.id)) {
          task.status = 'failed'; task.phase = 'failed'; task.error = '应用重启中断了发布包装任务，请重试。'; task.updatedAt = now; task.completedAt = now; changed = true
        }
      }
      if (changed) await writeTasks(root, data)
      return data.tasks
    })
  }

  async #mutateTask(root, id, mutate) {
    return this.#serial(root, async () => {
      const data = await readTasks(root)
      const task = data.tasks.find((item) => item.id === id)
      if (!task) fail('SPOKEN_VIDEO_NOT_FOUND', '发布任务不存在。')
      const before = structuredClone(task)
      await mutate(task)
      executionTransition(before, task, task.coverKind ? '封面生图服务' : '发布资料处理')
      task.updatedAt = new Date().toISOString()
      await writeTasks(root, data)
      return task
    })
  }

  /** DSH trace lands in the task file through the same serial write seam, so
   *  the publish page can show the packaging agent's live progress. */
  async #recordTaskDshStarted(root, taskId, run) {
    const childSessionId = typeof run?.childSessionId === 'string' ? run.childSessionId : null
    if (!childSessionId) return null
    return this.#mutateTask(root, taskId, (task) => {
      const trace = ensureDshTrace(task)
      trace.childSessionId = childSessionId
      trace.parentSessionId = typeof run.parentSessionId === 'string' ? run.parentSessionId : null
      appendDshTrace(trace, dshChildStarted(new Date().toISOString()))
    })
  }

  async #recordTaskDshEvent(root, taskId, event) {
    const projected = projectDshSessionEvent(event, new Date().toISOString())
    if (!projected) return null
    return this.#mutateTask(root, taskId, (task) => {
      appendDshTrace(ensureDshTrace(task), projected)
    })
  }

  async #run(agent, root, taskId) {
    let task
    try {
      task = await this.#mutateTask(root, taskId, (item) => { item.status = 'running'; item.phase = 'agent' })
      if (!this.packageExecutor) fail('SPOKEN_VIDEO_PUBLISH_AGENT_UNAVAILABLE', '当前环境不提供发布包装 Agent。')
      const detail = await this.projectsStore.get(agent, { projectId: task.projectId })
      if (detail.revision !== task.expectedRevision) fail('SPOKEN_VIDEO_REVISION_CONFLICT', '项目已更新，旧版本发布任务已取消。')
      const generated = normalizePublishResult(await this.packageExecutor({
        prompt: buildPublishPrompt({ project: detail }),
        schema: PUBLISH_PACKAGE_SCHEMA,
        agent,
        onDshStarted: (run) => this.#recordTaskDshStarted(root, taskId, run),
        onDshEvent: (event) => this.#recordTaskDshEvent(root, taskId, event),
      }))
      await this.#mutateTask(root, taskId, (item) => { item.result = generated; executionEvent(item, '发布文案与封面提示词已生成', { actor: 'DSH' }) })
      const covers = { landscape: null, portrait: null }
      const coverErrors = { landscape: null, portrait: null }
      if (task.imageProvider) {
        await this.#mutateTask(root, taskId, (item) => { item.phase = 'covers' })
        await Promise.all(['landscape', 'portrait'].map(async (kind) => {
          try {
            covers[kind] = await this.#generateCover(agent, task, kind, generated.prompts[kind], generated.prompts.negative)
            await this.#mutateTask(root, taskId, (item) => { item.result = { ...generated, covers: { ...(item.result?.covers || {}), [kind]: covers[kind] } }; executionEvent(item, `${kind === 'landscape' ? '横版' : '竖版'}封面已生成`, { actor: '封面生图服务', detail: covers[kind] }) })
          }
          catch (error) { coverErrors[kind] = error instanceof Error ? error.message : String(error); await this.#mutateTask(root, taskId, (item) => { executionEvent(item, `${kind === 'landscape' ? '横版' : '竖版'}封面生成失败`, { actor: '封面生图服务', status: 'error', detail: coverErrors[kind] }) }) }
        }))
      }
      const current = await this.projectsStore.get(agent, { projectId: task.projectId })
      if (current.revision !== task.expectedRevision) fail('SPOKEN_VIDEO_REVISION_CONFLICT', '项目已更新，旧版本发布任务已取消。')
      const committed = await this.projectsStore.commitProduced(agent, {
        projectId: task.projectId, expectedRevision: task.expectedRevision, stage: 'packaging', idempotencyKey: `publish-${task.id}`, source: 'spoken-video/publish-agent',
        payload: { mode: 'agent', taskId: task.id, ...generated, covers, imageProvider: task.imageProvider, coverErrors, generatedAt: new Date().toISOString() },
      })
      await this.#mutateTask(root, taskId, (item) => { item.status = 'succeeded'; item.phase = 'ready'; item.completedAt = new Date().toISOString(); item.coverErrors = coverErrors; item.result = { ...generated, covers, coverErrors }; item.resultRevision = committed.project.revision })
    } catch (error) {
      await this.#mutateTask(root, taskId, (item) => { item.status = 'failed'; item.phase = 'failed'; item.error = error instanceof Error ? error.message : String(error); item.completedAt = new Date().toISOString() }).catch(() => {})
    }
  }

  async #json(url, init, label) {
    let response
    try { response = await this.fetch(url, init) } catch (error) { fail('SPOKEN_VIDEO_PUBLISH_SERVICE_UNREACHABLE', `${label}不可访问：${error instanceof Error ? error.message : String(error)}`) }
    let body
    try { body = await response.json() } catch { fail('SPOKEN_VIDEO_PUBLISH_SERVICE_FAILED', `${label}返回了无效 JSON。`) }
    if (!response.ok) fail('SPOKEN_VIDEO_PUBLISH_SERVICE_FAILED', `${label}失败：${body?.message || body?.error?.message || `HTTP ${response.status}`}`)
    return body
  }

  async #generateCover(agent, task, kind, prompt, negativePrompt) {
    const provider = task.imageProvider.provider
    let call
    if (provider === 'lwb') {
      if (!task.imageProvider.lwbUserId) fail('SPOKEN_VIDEO_PUBLISH_CREDENTIAL_REQUIRED', '该任务缺少 LWB 账号归属，请重新创建。')
      const service = await this.account.open('cover-image', { userId: task.imageProvider.lwbUserId })
      call = (path, init) => service.request(path, init)
    } else {
      const resolved = await this.#credentials().resolve(publishImageCredentialRef(provider))
      if (!resolved?.value) fail('SPOKEN_VIDEO_PUBLISH_CREDENTIAL_REQUIRED', '百炼 BYOK 尚未保存 API Key。')
      const baseUrl = publishImageConfig(this.environment).bailianBaseUrl
      call = (path, init) => this.#json(`${baseUrl}${path}`, { ...init, headers: { Authorization: `Bearer ${resolved.value}`, 'Content-Type': 'application/json', 'X-DashScope-Async': 'enable' } }, '百炼封面生成服务')
    }
    const body = publishImageRequest({ model: task.imageProvider.model, prompt, negativePrompt, size: kind === 'landscape' ? '1280*720' : '720*1280' })
    if (provider === 'lwb') delete body.model
    let result = await call(provider === 'lwb' ? '/api/lwb/cover-images' : '/api/v1/services/aigc/image-generation/generation', { method: 'POST', body: JSON.stringify(body) })
    const remoteTaskId = imageTaskId(result)
    await this.#mutateTask(await publishRootFor(agent), task.id, (item) => { executionEvent(item, `${kind === 'landscape' ? '横版' : '竖版'}封面请求已提交`, { actor: '封面生图服务', detail: { taskId: remoteTaskId || null, model: task.imageProvider.model, prompt, negativePrompt } }) })
    if (!extractPublishImageUrl(result) && remoteTaskId) {
      const deadline = Date.now() + this.maxPollMs
      while (Date.now() < deadline) {
        if (this.pollIntervalMs > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, this.pollIntervalMs))
        result = await call(`/api/v1/tasks/${encodeURIComponent(remoteTaskId)}`, { method: 'GET' })
        const state = imageTaskState(result)
        if (['FAILED', 'CANCELED', 'CANCELLED', 'UNKNOWN'].includes(state)) fail('SPOKEN_VIDEO_PUBLISH_SERVICE_FAILED', '封面生成任务失败。')
        if (extractPublishImageUrl(result)) break
      }
    }
    const url = extractPublishImageUrl(result)
    if (!url) fail('SPOKEN_VIDEO_PUBLISH_SERVICE_FAILED', '封面生成服务未返回图片。')
    let response
    try { response = await this.fetch(boundedUrl(url, '封面生成服务'), { method: 'GET' }) } catch (error) { fail('SPOKEN_VIDEO_PUBLISH_SERVICE_UNREACHABLE', `生成的封面无法下载：${error instanceof Error ? error.message : String(error)}`) }
    if (!response.ok) fail('SPOKEN_VIDEO_PUBLISH_SERVICE_FAILED', `生成的封面下载失败：HTTP ${response.status}`)
    const declared = Number(response.headers?.get?.('content-length'))
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) fail('SPOKEN_VIDEO_PUBLISH_FILE_TOO_LARGE', '生成的封面超过 20 MiB。')
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > MAX_IMAGE_BYTES) fail('SPOKEN_VIDEO_PUBLISH_FILE_TOO_LARGE', '生成的封面超过 20 MiB。')
    const inspected = inspectPublishImage(bytes)
    return this.#freezeCover(agent, task.projectId, kind, bytes, inspected, 'generated')
  }

  async #freezeCover(agent, id, kind, bytes, inspected, source) {
    const root = await projectRootFor(agent, id)
    const file = `media/publish-covers/${kind}-${randomUUID()}.${inspected.extension}`
    const target = await safeTarget(root, file, true)
    try { await writeFile(target, bytes, { mode: 0o600, flag: 'wx' }) } catch (error) { await unlink(target).catch(() => {}); throw error }
    return { file, mediaType: inspected.mediaType, bytes: inspected.bytes, width: inspected.width, height: inspected.height, source }
  }

  async updatePackaging(agent, request) {
    const input = object(request, '更新发布内容请求')
    const id = projectId(input.projectId)
    const expectedRevision = revision(input.expectedRevision)
    const detail = await this.projectsStore.get(agent, { projectId: id })
    const current = detail.artifacts?.packaging?.data
    if (!current) fail('SPOKEN_VIDEO_STAGE_BLOCKED', '请先生成发布信息。')
    return this.projectsStore.commitProduced(agent, { projectId: id, expectedRevision, stage: 'packaging', idempotencyKey: `publish-edit-${randomUUID()}`, source: 'spoken-video/publish-editor', payload: { ...current, mode: 'manual-update', content: contentInput(input.content), prompts: promptsInput(input.prompts, current.prompts), generatedAt: new Date().toISOString() } })
  }

  async uploadCover(agent, request) {
    const input = object(request, '上传封面请求')
    const id = projectId(input.projectId)
    const expectedRevision = revision(input.expectedRevision)
    const kind = text(input.kind, '封面方向', 20).toLowerCase()
    if (!['landscape', 'portrait'].includes(kind)) fail('SPOKEN_VIDEO_PUBLISH_INVALID_INPUT', '封面方向无效。')
    const bytes = base64(input.data)
    const inspected = inspectPublishImage(bytes)
    if ((kind === 'landscape' && inspected.width <= inspected.height) || (kind === 'portrait' && inspected.height <= inspected.width)) fail('SPOKEN_VIDEO_PUBLISH_IMAGE_INVALID', kind === 'landscape' ? '横屏封面宽度必须大于高度。' : '竖屏封面高度必须大于宽度。')
    const detail = await this.projectsStore.get(agent, { projectId: id })
    const current = detail.artifacts?.packaging?.data
    if (!current) fail('SPOKEN_VIDEO_STAGE_BLOCKED', '请先生成发布信息，再上传封面。')
    const cover = await this.#freezeCover(agent, id, kind, bytes, inspected, 'upload')
    try {
      return await this.projectsStore.commitProduced(agent, { projectId: id, expectedRevision, stage: 'packaging', idempotencyKey: `publish-cover-${randomUUID()}`, source: 'spoken-video/publish-upload', payload: { ...current, mode: 'cover-upload', covers: { ...current.covers, [kind]: cover }, coverErrors: { ...current.coverErrors, [kind]: null }, generatedAt: new Date().toISOString() } })
    } catch (error) {
      const root = await projectRootFor(agent, id)
      await unlink(await safeTarget(root, cover.file)).catch(() => {})
      throw error
    }
  }

  async readAsset(agent, request) {
    const input = object(request, '读取发布媒体请求')
    const id = projectId(input.projectId)
    const kind = text(input.kind, '发布媒体类型', 20).toLowerCase()
    const detail = await this.projectsStore.get(agent, { projectId: id })
    let descriptor
    if (kind === 'video' || kind === 'thumbnail') descriptor = detail.artifacts?.video?.data?.video
    else if (['landscape', 'portrait'].includes(kind)) descriptor = detail.artifacts?.packaging?.data?.covers?.[kind]
    else fail('SPOKEN_VIDEO_PUBLISH_INVALID_INPUT', '发布媒体类型无效。')
    if (!descriptor?.file || !descriptor?.mediaType) fail('SPOKEN_VIDEO_PUBLISH_FILE_INVALID', '当前没有可读取的发布媒体。')
    const root = await projectRootFor(agent, id)
    const file = await safeTarget(root, descriptor.file)
    const info = await stat(file)
    if (kind === 'thumbnail') {
      // Small on-demand first frame; never transfer an entire video just to
      // draw a history row. The file signature invalidates replaced media.
      const key = `${file}:${info.size}:${info.mtimeMs}`
      let pending = this.thumbnails.get(key)
      if (!pending) {
        const worker = this.thumbnailWorkerIndex++ % this.thumbnailWorkers.length
        pending = this.thumbnailWorkers[worker].then(() => execFileAsync('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', 'scale=480:480:force_original_aspect_ratio=decrease', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], { encoding: 'buffer', maxBuffer: 2 * 1024 * 1024, timeout: 15000 }))
          .then(({ stdout }) => {
            if (!stdout.length) fail('SPOKEN_VIDEO_PUBLISH_FILE_INVALID', '无法提取视频缩略图。')
            return { mediaType: 'image/jpeg', bytes: stdout.length, data: stdout.toString('base64') }
          }).catch((error) => { this.thumbnails.delete(key); throw error })
        this.thumbnailWorkers[worker] = pending.catch(() => {})
        if (this.thumbnails.size >= 100) this.thumbnails.delete(this.thumbnails.keys().next().value)
        this.thumbnails.set(key, pending)
      }
      return pending
    }
    if (info.size > MAX_ASSET_BYTES) fail('SPOKEN_VIDEO_PUBLISH_FILE_TOO_LARGE', '发布媒体超过浏览器读取的 80 MiB 限制。')
    return { file: descriptor.file, mediaType: descriptor.mediaType, bytes: info.size, data: (await readFile(file)).toString('base64') }
  }

  /**
   * Regenerate one cover direction from a (possibly hand-edited) prompt without
   * touching the publish copy. Runs as a task so the drawer can poll: image
   * providers may take minutes, and a blocking RPC would stall the browser.
   */
  async regenerateCover(agent, request) {
    const input = object(request, '重新生成封面请求')
    const id = projectId(input.projectId)
    const expectedRevision = revision(input.expectedRevision)
    const kind = text(input.kind, '封面方向', 20).toLowerCase()
    if (!['landscape', 'portrait'].includes(kind)) fail('SPOKEN_VIDEO_PUBLISH_INVALID_INPUT', '封面方向无效。')
    const prompt = text(input.prompt, '封面提示词', 3000)
    const negativePrompt = typeof input.negativePrompt === 'string' ? input.negativePrompt.slice(0, 1000) : ''
    const settings = await this.status()
    if (settings.configured !== true) fail('SPOKEN_VIDEO_PUBLISH_CONNECTION_UNAVAILABLE', '请在「封面生图配置」中登录 LWB 账号或配置百炼 API Key。')
    const detail = await this.projectsStore.get(agent, { projectId: id })
    if (detail.revision !== expectedRevision) fail('SPOKEN_VIDEO_REVISION_CONFLICT', '项目已更新，请刷新后重试。')
    if (detail.artifacts?.qc?.data?.passed !== true) fail('SPOKEN_VIDEO_STAGE_BLOCKED', '只有质检通过的成片才能生成封面。')
    if (!detail.artifacts?.packaging?.data) fail('SPOKEN_VIDEO_STAGE_BLOCKED', '请先生成发布信息，再单独重生封面。')
    const root = await publishRootFor(agent)
    const task = {
      id: randomUUID(), projectId: id, projectTitle: detail.title, account: detail.account || null,
      status: 'queued', phase: 'covers', coverKind: kind, prompt, negativePrompt, error: null, expectedRevision,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null,
      imageProvider: { provider: settings.provider, model: settings.model, ...(settings.provider === 'lwb' ? { lwbUserId: settings.providers.lwb.credential.userId } : {}) }, coverErrors: {},
      dsh: dshTrace(),
    }
    await this.#serial(root, async () => { const data = await readTasks(root); data.tasks.unshift(task); await writeTasks(root, data) })
    this.active.add(task.id)
    void this.background(this.#runCover(agent, root, task.id).finally(() => this.active.delete(task.id)))
    return taskSummary(task)
  }

  async #runCover(agent, root, taskId) {
    try {
      const task = await this.#mutateTask(root, taskId, (item) => { item.status = 'running' })
      const kind = task.coverKind
      const cover = await this.#generateCover(agent, task, kind, task.prompt, task.negativePrompt)
      await this.#mutateTask(root, taskId, (item) => { item.result = { covers: { [kind]: cover }, prompts: { [kind]: task.prompt, negative: task.negativePrompt } }; executionEvent(item, '封面已生成', { actor: '封面生图服务', detail: cover }) })
      // Re-read right before committing: the prompt and the frozen cover land in
      // one packaging revision, so the copy the user edited stays intact.
      const fresh = await this.projectsStore.get(agent, { projectId: task.projectId })
      if (fresh.revision !== task.expectedRevision) fail('SPOKEN_VIDEO_REVISION_CONFLICT', '项目已更新，旧版本封面任务已取消。')
      const current = fresh.artifacts?.packaging?.data
      if (!current) fail('SPOKEN_VIDEO_STAGE_BLOCKED', '发布信息已不存在，无法重生封面。')
      const committed = await this.projectsStore.commitProduced(agent, {
        projectId: task.projectId, expectedRevision: task.expectedRevision, stage: 'packaging', idempotencyKey: `publish-cover-${task.id}`, source: 'spoken-video/publish-agent',
        payload: {
          ...current, mode: 'cover-regenerate',
          prompts: { ...current.prompts, [kind]: task.prompt, negative: task.negativePrompt },
          covers: { ...current.covers, [kind]: cover },
          coverErrors: { ...current.coverErrors, [kind]: null },
          imageProvider: task.imageProvider, generatedAt: new Date().toISOString(),
        },
      })
      await this.#mutateTask(root, taskId, (item) => { item.status = 'succeeded'; item.phase = 'ready'; item.completedAt = new Date().toISOString(); item.resultRevision = committed.project.revision })
    } catch (error) {
      await this.#mutateTask(root, taskId, (item) => {
        item.status = 'failed'; item.phase = 'failed'; item.error = error instanceof Error ? error.message : String(error); item.completedAt = new Date().toISOString()
        item.coverErrors = { ...item.coverErrors, [item.coverKind]: item.error }
      }).catch(() => {})
    }
  }
}
