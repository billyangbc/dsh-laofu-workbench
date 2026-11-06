# P1+P2 缺陷修正实施方案

日期：2026-11-04。审查依据：`docs-local/系统设计与功能说明.md`（v0.1.9 @ a7b235a 四路审查，缺陷编号沿用其第五节）。
范围：P1 全部 3 项 + P2 全部 18 项；P3 长尾不在本方案内。
分支：`fix/defects-p1p2`；每批 1-3 笔 conventional commits；验证 = 每批 TDD（红→绿）+ 对应套件，收尾 `npm test` 全量。批次 5 不跑真实打包（Electron 下载过重），以脚本级单测 + `npm run package:plan` dry-run 验证。

已拍板的两个取向：

- **P1-1 保守加固**：保留 `--no-sandbox` shim（根因在 `@playwright/mcp` 不转发 args），加显式关闭开关、CDP 端口指纹校验、端口文件权限与文档明示；不做连接方式重构。
- **P1-2 排除即告警**：payload 对凭据类文件跳过并告警（与发布腿 git archive 尊重 gitignore 的行为对齐），不抛错中断。

---

## 批次 1 — P1 致命三修

### 1a. arena sessionSeq 死锁（原 P1-3）

- 位置：`lwb/packs/ai-arena/host.mjs:162-190`（`playerSession`）、`:305`（afterSeq 读取）。
- 根因：`sessions.resume` 失败后 `sessions.create` 新建替换会话，但 `players[].sessionSeq` 保留旧会话高 seq；`dsh-session.mjs` 的 boundary = max(afterSeq, 新会话 cursor) = 旧值，新会话事件 seq 从 0 起，永远取不到回复 → 每次人工 resume 都真实调用模型并再次 paused。
- 修复：`playerSession` 走「新建替换」分支时，经 store mutate 把 `players[player].sessionSeq` 重置为 0 并落盘；内存 `this.sessions` 缓存 key 不变。
- 测试：`test/host.test.mjs` 增例——构造 resume 抛错的 scope 桩，断言新会话建立后 match 记录里 `sessionSeq === 0`，且下一手 `afterSeq` 从 0 起。

### 1b. payload 凭据排除（原 P1-2）

- 位置：`lwb/desktop/payload.mjs:19`（`EXCLUDED`）。
- 修复：排除规则从「目录名集合」扩展为目录名 + basename 模式：`.env`、`.env.*`、`*.pem`、`*.key`、`*.p12`、`*.pfx`、`*credential*`、`*secret*`、`.npmrc`。命中凭据模式时收集告警（`onFile` 旁路），`assembleProductPayload` 结束时统一 stderr 输出被跳过文件清单；不抛错。
- 测试：`lwb/desktop/` 新增 payload 测试——临时目录放置 `.env`/`key.pem`/正常文件，断言凭据文件不进 payload、正常文件进、告警清单正确。

### 1c. 浏览器保守加固（原 P1-1）

- `browser-shim.mjs`：新增 `LWB_BROWSER_NO_SANDBOX=0|false|off` 显式关闭开关——关闭时 `resolveBrowserExecutable()` 直接返回 `undefined`（走 provider 默认，即带沙箱；在 MCP 上游缺陷未修的环境下该会话可能起不来，属于用户显式选择）。
- `pack-browser.mjs`：① 端口文件 `writeFile` mode 0600；② 启动成功后把 `/json/version` 的 `Browser` 字段写入端口文件（`<port> <browser>` 两行），`alive()`/连接前校验指纹一致，不一致视为浏览器不在（走重启），防端口被复用误连。
- 文档：`docs/12-capability-packs.md` 预设小节补风险明示（无沙箱 + 本地 CDP 无鉴权 + 关闭开关）；`docs/troubleshooting.md` 加环境变量说明。
- 测试：`browser-shim.test.mjs` 增开关用例；`pack-browser.test.mjs` 增指纹校验用例。

## 批次 2 — spoken-video 数据完整性（#4-8）

| # | 修复 |
|---|---|
| 4 | `media-host.mjs #start` 的 read→append→write 收进 `runWrites` 串行链（复用 `#mutateRun` 的队列语义，保持对外返回结构不变） |
| 5 | `#recoverInterruptedRuns`、`#recoverInterruptedAudioTasks`（media-host）与 publish `#recoverInterrupted` 全部改为在各自串行锁内读改写，基于锁内快照落盘；恢复逻辑保持幂等 |
| 6 | `#runAudioTask`/`#runAudioTaskSubtitles` 的首个状态变更移入 try；`background(promise.finally(...))` 调用处补 `.catch`，把失败原因写入任务记录（任务转 failed 而非 unhandled rejection） |
| 7 | 启动恢复时重置候选 `selection.state` 中残留的 `activating/deactivating` 为稳态（恢复到变更前语义：按 presence 反推），允许后续重试 |
| 8 | `schedule-host startRun` 的 `active` 检查移进 `mutate` 临界区（读 `schedules.json` 后、写盘前在同一临界区内判重），消灭 check-then-act 窗口 |

测试：spoken-video 套件增并发提交/恢复覆盖/后台失败用例（用现有测试基建的假 scope + 临时目录）。

## 批次 3 — 超时/并发/无界增长（#9、11-14）

| # | 修复 |
|---|---|
| 9 | `remotion.mjs` 渲染前后对共享 node_modules 做清单 hash（文件路径+size+mtime→摘要，写入任务目录），不一致即任务失败并在报告中列出被改动条目；保守检测方案，不做隔离重构 |
| 11 | `ai-arena/export.mjs renderMedia` 外包 `AbortSignal.timeout(45min)`（可 env 覆盖 `LWB_ARENA_EXPORT_TIMEOUT_MS`），超时→export 状态 failed、释放 running 通道 |
| 12 | model-review：`launchRun` 的 `whenIdle()` 加 30min 超时竞速（超时→run failed 带原因）；`start` 改为并发上限 4（其余排队串行启动），上限可 env 覆盖 |
| 13 | 先加测试钉住「arena 会话 `tools:'none'` → DSH 原生压缩已启用」；`host.mjs:217` continuation 不再整段重复 system 指令（改为短催促语，规则要点已在首系统指令里） |
| 14 | arena `store.list()` 提供 `summary()` 投影（剥离 events/exports 大字段）供列表端点使用，`match()` 详情仍全量；model-review `evaluations.json` 索引去掉 `runs[].answer` 全文（answer 留在各 task.json，读取路径已按 task 文件取） |

## 批次 4 — 内核健壮性（#15-18）

| # | 修复 |
|---|---|
| 15 | `ats-client.mjs` 构造不再 throw：baseUrl 非法时进入 `unavailable` 态（所有请求返回明确错误），`account-gateway`/entitlements 感知该态并在 UI 侧显示配置错误；产品壳正常启动 |
| 16 | `pack-runtime-links.mjs` Desktop 拷贝前在目标写 `source-manifest.json`（源树摘要），摘要一致则跳过 rm+cp |
| 17 | `pack-services.mjs` 凭据 ref 去掉 `toLowerCase()/_→-` 归一（长度前缀编码无歧义），读取时兼容旧归一形态 |
| 18 | `pack-manager.mjs` writeRegistry 补 finally unlink 临时文件；marketplace 对 workspace/commercial 源同 id 冲突降级为该条目 `available:false, reason`，不再整体抛错炸市场与启动恢复 |

## 批次 5 — 桌面/发布链（#19-25）

| # | 修复 |
|---|---|
| 19 | `package-inputs.mjs`：SHASUMS256.txt 恒从官方 `github.com/electron/electron/releases` 取（zip 可继续走镜像）；官方源不可达即构建失败，不降级 |
| 20 | `release-desktop.mjs`：发布 commercial 时读私有仓 `inputs.json`，核对 `productSnapshotCommit` 与本次发布 git commit 一致、`includesLocalTrackedChanges === false`，不符拒绝 |
| 21 | `package-inputs.mjs` 产物目录已存在且非空即拒绝（提示清空或换 edition/target），消灭并发互写 |
| 22 | `bootstrap.mjs`：启动时对 runtime 副本 `lwb/` 核心入口（dsh-bundle index/client、pack-sdk、profile-setup）按 build.json digest 抽查，不符则整副本重建 |
| 23 | `lwb-update.sh`：open 新 app 后探测进程存活（pgrep + 宽限期），存活才删备份；失败恢复 `.lwb-old` 并报告失败 |
| 24 | `collect-desktop-artifacts.mjs`：签名/便携状态从构建产物与 env 读取，不再硬编码 `unsigned:true`（未知时如实标 unknown） |
| 25 | `package-inputs.mjs` 子进程环境改 allowlist：`PATH/HOME/LOCALAPPDATA/TEMP/TMP/USERPROFILE/LANG/LC_*`、`LWB_*`、`DSH_*`、`ELECTRON_*`、npm/Corepack/代理变量；其余丢弃并打印一条摘要 |

## 实施中的范围调整（2026-11-05）

- **#14（IO 膨胀）降级为后续独立任务**：实施核查发现 `task()` 与客户端直接从共享索引读 `run.answer` 全文，正确的瘦身需要「索引存摘要字段 + task() 改读 task.json 全量 + 恢复路径与客户端读法同步改造」的数据迁移级重构，赶在本程序尾部实施有丢用户答案的风险。arena 侧 `list()` 本已剥离 events，剩余成本是全文件读与 1s 详情轮询，属性能而非正确性。留待单独提案。
- **#17（凭据 ref 归一化碰撞）核实为非缺陷**：`packCredentialRef` 的长度前缀取自归一后字符串，`my-key`(6) 与 `mykey`(5) 编码不同、互不覆盖；仅大小写变体共享槽位，而包作者惯例使用大写常量声明 ref，实际不可达。已用回归测试钉住现行为与旧形态可读性，不改存储格式（改动会让存量用户凭据需要迁移）。

## 批次 5 实施调整（2026-11-05）

- **#19 改为「默认不自动回退镜像」**：@electron/get 从 `ELECTRON_MIRROR` 同源取 zip 与 SHASUMS256.txt，无法只让校验文件走官方源。默认行为改为「官方源不可达即失败并给出三个知情选项」（检查网络 / 显式 `ELECTRON_MIRROR` / `LWB_ELECTRON_MIRROR=auto` 恢复旧自动回退）。这保持了「网络全断失败好过投毒通过」的目标，同时把第三方镜像从默认路径变成显式选择。
- **#23 macOS 更新回滚以进程存活探测实现**（open 后 30s 内 pgrep 到新 bundle 进程才算成功，失败恢复 `.lwb-old`）；该 shell 安装器无法在无 root 桩的环境里单测，以 `sh -n` + 逻辑审阅为界。
- **#24 签名状态**：采集脚本拒绝一切非 `-unsigned` 产物，因此 `unsigned/portable` 从产物文件名派生、`notarized` 恒 false 并在注释中声明「签名流需要自己的采集器」，不再对未知状态硬编码成功口径。

## 风险与回滚

- 每批独立成 commit，可单独 revert；行为面变化最大的是 #14（列表投影）与 #25（环境 allowlist），若下游有未预见依赖以批次为单位回退。
- #22 抽查失败重建副本只在打包态生效，开发态（checkout 启动）不涉及。
- 批次 5 全部为构建期脚本，不影响运行时行为。
