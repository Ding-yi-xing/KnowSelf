#!/usr/bin/env node
/**
 * dsh 升级守护：一条命令判断"官方升级之后，knowSelf 插件还能不能用"。
 *
 * 设计前提（均来自本项目实测）：
 *   1. 插件随 dsh 升级只会遇到四类断点：包形态、bundle externals、原生模块 ABI、peer 版本。
 *   2. Electron 大版本一变 ABI 必变，profiles/<name>/node_modules 里的 .node 必须重编。
 *   3. peerDependencies 是精确版本语义，官方用 allow-version 显式豁免，不是范围匹配。
 *   4. 本机全局注入 NODE_OPTIONS / ELECTRON_RUN_AS_NODE，跑 electron 前必须剥掉。
 *
 * 用法：
 *   node scripts/dsh-upgrade-check.mjs                 # C1~C7 静态 + 模块加载（约 10 秒）
 *   node scripts/dsh-upgrade-check.mjs --smoke         # 追加 C8：真启动 Desktop 验 6 面板（约 2 分钟）
 *   node scripts/dsh-upgrade-check.mjs --json
 *   node scripts/dsh-upgrade-check.mjs --profile kdesk --electron C:/path/to/electron
 *
 * 退出码：0 全绿；1 存在 FAIL。WARN 不影响退出码，但需要人看。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, openSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 原生模块：桌面侧要 Electron ABI，插件侧要 Node ABI。 */
const NATIVE = ['better-sqlite3', 'better-sqlite3-multiple-ciphers']
/** bundle 必须保持 external 的 specifier，被内联说明构建配置退化。 */
const EXTERNALS = ['better-sqlite3', 'better-sqlite3-multiple-ciphers', '@node-rs/jieba']
/** 用来反查"实际会运行插件的 dsh 版本"。 */
const PEER_PROBE = '@deepseek-ai/dsh-agent'
/** 这些包属于官方 dsh runtime，profile 里有实体副本会破坏 scope 身份。 */
const PROFILE_FORBIDDEN_RUNTIME_COPIES = [
  'cordis',
  'dsh-agent',
  'dsh-scope',
  'dsh-session',
  'dsh-settings',
  'dsh-system-prompt',
  'dsh-tools',
]

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? fallback : argv[index + 1]
}
const asJson = argv.includes('--json')

const repoRoot = resolve(argOf('repo', resolve(dirname(fileURLToPath(import.meta.url)), '..')))
const profileName = argOf('profile', 'desktop')
const profileDir = resolve(argOf('profile-dir', join(homedir(), '.dsh', 'profiles', profileName)))
const electronDir = resolve(
  argOf('electron', 'C:/dsh-lab/_deepseek-harness/apps/desktop/node_modules/electron'),
)
const pluginDir = join(repoRoot, 'dsh', 'knowself')

const results = []
const record = (level, id, title, detail) => results.push({ level, id, title, detail: detail ?? '' })
const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** 剥掉本机注入的 NODE_OPTIONS；ELECTRON_RUN_AS_NODE 只在显式要求时保留。 */
const cleanEnv = (asNode = false) => {
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  if (asNode) env.ELECTRON_RUN_AS_NODE = '1'
  else delete env.ELECTRON_RUN_AS_NODE
  return env
}

/**
 * 取 Electron 版本与可执行文件路径：**优先静态文件**，`reg.exe` 只作兜底。
 *
 * 为什么要这么改：受管环境的程序黑名单会把 `reg.exe` 拦死（QA 实测因此拿不到 C8），
 * 而版本号本来就静态写在包里 —— 没有任何理由为了它去问注册表。
 * 顺序：`package.json` → `dist/version` → `path.txt`（同目录 version）→ `reg query` → null。
 * 任何一步失败都只降级，不抛错、不 FAIL。
 *
 * @param {string} electronRoot `node_modules/electron` 目录
 * @returns {{ version: string | null, source: string, exe: string }}
 */
const electronProbeInfo = (electronRoot) => {
  const exeName = process.platform === 'win32' ? 'electron.exe' : 'electron'
  // ① 可执行文件：常规位置，其次按 path.txt（electron 包的约定文件）
  let exe = join(electronRoot, 'dist', exeName)
  if (!existsSync(exe)) {
    try {
      const rel = readFileSync(join(electronRoot, 'path.txt'), 'utf8').trim()
      if (rel !== '') exe = join(electronRoot, rel)
    } catch {
      /* 没有 path.txt 就保持常规位置 */
    }
  }
  // ② 版本：静态文件优先
  const pkg = readJson(join(electronRoot, 'package.json'))
  if (typeof pkg?.version === 'string' && pkg.version.trim() !== '') {
    return { version: pkg.version.trim(), source: 'package.json', exe }
  }
  for (const rel of [join('dist', 'version'), 'version']) {
    try {
      const value = readFileSync(join(electronRoot, rel), 'utf8').trim()
      if (value !== '') return { version: value, source: rel, exe }
    } catch {
      /* 继续下一个候选 */
    }
  }
  // ③ 兜底：注册表（可能被安全策略拦；失败只降级）
  try {
    const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', 'electron'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const hit = out.match(/"DisplayVersion"\s+REG_SZ\s+([^\r\n]+)/)
    if (hit?.[1]) return { version: hit[1].trim(), source: 'reg.exe', exe }
  } catch {
    /* reg.exe 被拦或不存在：不影响判定 */
  }
  return { version: null, source: 'unknown', exe }
}

/** 在指定运行时里 new 一个内存库；返回 { ok, abi, message }。 */
const probeNative = (command, moduleDir, asNode) => {
  const code = [
    'try {',
    `  const D = require(${JSON.stringify(moduleDir)})`,
    "  const db = new D(':memory:')",
    "  db.prepare('SELECT 1 AS ok').get()",
    '  db.close()',
    '  process.stdout.write(JSON.stringify({ ok: true, abi: process.versions.modules }))',
    '} catch (error) {',
    '  process.stdout.write(JSON.stringify({',
    '    ok: false,',
    '    abi: process.versions.modules,',
    "    message: String(error.message).split('\\n')[0],",
    '  }))',
    '}',
  ].join('\n')
  try {
    const stdout = execFileSync(command, ['-e', code], {
      encoding: 'utf8',
      env: cleanEnv(asNode),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return JSON.parse(stdout.trim().split('\n').filter(Boolean).pop() ?? '{}')
  } catch (error) {
    return { ok: false, message: String(error.message).split('\n')[0] }
  }
}

const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase()

const sha256TgzEntry = (archive, entry) => {
  const bytes = execFileSync('tar', ['-xOf', archive, entry], {
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })
  return createHash('sha256').update(bytes).digest('hex').toUpperCase()
}

const profileTgzPath = () => {
  const profilePkg = readJson(join(profileDir, 'package.json'))
  const spec = profilePkg?.dependencies?.['@knowself/dsh-plugin']
  if (typeof spec !== 'string' || !spec.startsWith('file:') || !spec.endsWith('.tgz')) return null
  return resolve(profileDir, spec.slice('file:'.length))
}

// C0 repo -> tgz -> profile 产物一致性；防止本地 dist 全绿但 Desktop 仍运行旧 bundle。
{
  const repoServer = join(pluginDir, 'dist', 'bundle', 'index.js')
  const repoClient = join(pluginDir, 'dist', 'client-bundle', 'client.js')
  const profileServer = join(profileDir, 'node_modules', '@knowself', 'dsh-plugin', 'dist', 'bundle', 'index.js')
  const profileClient = join(
    profileDir,
    'node_modules',
    '@knowself',
    'dsh-plugin',
    'dist',
    'client-bundle',
    'client.js',
  )
  const missing = [repoServer, repoClient, profileServer, profileClient].filter((path) => !existsSync(path))
  const tgz = profileTgzPath()
  if (missing.length > 0) {
    record('FAIL', 'C0', 'repo / tgz / profile 产物一致性', `缺少 bundle：${missing.join('；')}`)
  } else if (tgz === null) {
    record('WARN', 'C0', 'repo / tgz / profile 产物一致性', 'profile 未引用可解析的本地 .tgz，已跳过 tgz 层')
  } else if (!existsSync(tgz)) {
    record('FAIL', 'C0', 'repo / tgz / profile 产物一致性', `profile 引用的 tgz 不存在：${tgz}`)
  } else {
    try {
      const hashes = {
        repoServer: sha256File(repoServer),
        tgzServer: sha256TgzEntry(tgz, 'package/dist/bundle/index.js'),
        profileServer: sha256File(profileServer),
        repoClient: sha256File(repoClient),
        tgzClient: sha256TgzEntry(tgz, 'package/dist/client-bundle/client.js'),
        profileClient: sha256File(profileClient),
      }
      const serverOk = hashes.repoServer === hashes.tgzServer && hashes.tgzServer === hashes.profileServer
      const clientOk = hashes.repoClient === hashes.tgzClient && hashes.tgzClient === hashes.profileClient
      record(
        serverOk && clientOk ? 'PASS' : 'FAIL',
        'C0',
        'repo / tgz / profile 产物一致性',
        serverOk && clientOk
          ? `server/client SHA-256 三处一致；tgz=${tgz}`
          : `server=${serverOk ? '一致' : '不一致'}；client=${clientOk ? '一致' : '不一致'}；` +
              `repo=${repoServer}`,
      )
    } catch (error) {
      record('FAIL', 'C0', 'repo / tgz / profile 产物一致性', `无法读取 tgz 内容：${String(error.message).split('\n')[0]}`)
    }
  }
}

// C1 插件包形态
const pluginPkg = readJson(join(pluginDir, 'package.json'))
if (!pluginPkg) {
  record('FAIL', 'C1', '插件包形态', `找不到 ${join(pluginDir, 'package.json')}`)
} else {
  const deps = Object.keys(pluginPkg.dependencies ?? {})
  const fileDeps = Object.values(pluginPkg.dependencies ?? {}).filter((value) =>
    String(value).startsWith('file:'),
  ).length
  const problems = []
  if (!pluginPkg.dsh?.bundle?.patch) problems.push('缺 dsh.bundle.patch')
  if (pluginPkg.main !== 'dist/bundle/index.js') problems.push(`main=${pluginPkg.main}`)
  if (pluginPkg.exports?.['.'] !== './dist/bundle/index.js') problems.push('exports["."] 未指向 bundle')
  if (deps.length !== 4) problems.push(`dependencies ${deps.length} 个（应 4）`)
  if (fileDeps !== 0) problems.push(`dependencies 含 ${fileDeps} 个 file:`)
  record(
    problems.length === 0 ? 'PASS' : 'FAIL',
    'C1',
    '插件包形态可被官方 CLI 装入',
    problems.length === 0
      ? `v${pluginPkg.version}；4 依赖、file: 0、dsh.bundle 就位`
      : problems.join('；'),
  )
}

// C2 bundle 与 externals
const bundlePath = join(pluginDir, 'dist', 'bundle', 'index.js')
if (!existsSync(bundlePath)) {
  record('FAIL', 'C2', 'server bundle 与 externals', 'dist/bundle/index.js 缺失，先跑 build-server-bundle')
} else {
  const bundle = readFileSync(bundlePath, 'utf8')
  const missing = EXTERNALS.filter((name) => !bundle.includes(`"${name}"`))
  record(
    missing.length === 0 ? 'PASS' : 'FAIL',
    'C2',
    'bundle externals 未被内联',
    missing.length === 0
      ? `${EXTERNALS.length} 个 specifier 在位；bundle ${(bundle.length / 1048576).toFixed(1)} MB`
      : `丢失：${missing.join(', ')}`,
  )
}

// C3 Electron 版本与 ABI
// 版本走 electronProbeInfo（静态文件优先，reg.exe 只兜底）；ABI 仍靠真跑一次探针。
const electronInfo = electronProbeInfo(electronDir)
const electronExe = electronInfo.exe
let electronAbi
if (electronInfo.version === null || !existsSync(electronExe)) {
  record(
    'SKIP',
    'C3',
    'Electron 版本与 ABI',
    `未取到 Electron 版本（来源 ${electronInfo.source}）或找不到 ${electronExe}（用 --electron 指定）`,
  )
} else {
  const probe = probeNative(electronExe, join(profileDir, 'node_modules', NATIVE[0]), true)
  electronAbi = probe.abi
  const nodeAbi = process.versions.modules
  record(
    'PASS',
    'C3',
    'Electron 版本与 ABI',
    `electron ${electronInfo.version}（来源 ${electronInfo.source}）/ ABI ${electronAbi ?? '未取到'}；本机 node ABI ${nodeAbi}` +
      (electronAbi && electronAbi !== nodeAbi ? '（两侧不同属预期，需各自重编）' : ''),
  )
}

// C4 profile 侧原生模块（Electron ABI）
if (!existsSync(join(profileDir, 'package.json'))) {
  record('SKIP', 'C4', `profile "${profileName}" 原生模块 ABI`, `未初始化：${profileDir}`)
} else if (!electronAbi) {
  record('SKIP', 'C4', `profile "${profileName}" 原生模块 ABI`, 'C3 未取到 Electron ABI')
} else {
  const bad = []
  for (const name of NATIVE) {
    const dir = join(profileDir, 'node_modules', name)
    if (!existsSync(dir)) {
      bad.push(`${name} 缺失`)
      continue
    }
    const probe = probeNative(electronExe, dir, true)
    if (!probe.ok) bad.push(`${name}: ${probe.message}`)
    else if (probe.abi !== electronAbi) bad.push(`${name}: abi ${probe.abi} ≠ ${electronAbi}`)
  }
  record(
    bad.length === 0 ? 'PASS' : 'FAIL',
    'C4',
    `profile "${profileName}" 原生模块在 Electron ABI 下可用`,
    bad.length === 0
      ? `${NATIVE.join(' / ')} 均 OPEN OK abi=${electronAbi}`
      : `${bad.join('；')} → 用 @electron/rebuild 重编`,
  )
}

// C5 插件侧原生模块（Node ABI）
{
  const bad = []
  for (const name of NATIVE) {
    const dir = join(pluginDir, 'node_modules', name)
    if (!existsSync(dir)) {
      bad.push(`${name} 缺失`)
      continue
    }
    const probe = probeNative(process.execPath, dir, false)
    if (!probe.ok) bad.push(`${name}: ${probe.message}`)
    else if (probe.abi !== process.versions.modules)
      bad.push(`${name}: abi ${probe.abi} ≠ ${process.versions.modules}`)
  }
  record(
    bad.length === 0 ? 'PASS' : 'FAIL',
    'C5',
    '插件侧原生模块在 Node ABI 下可用',
    bad.length === 0
      ? `${NATIVE.join(' / ')} 均 OPEN OK abi=${process.versions.modules}`
      : `${bad.join('；')} → 用裸 node-gyp rebuild 重编`,
  )
}

// C6 profile patch 层仍挂着插件
const patchPath = join(profileDir, 'cordis.patch.yml')
if (!existsSync(patchPath)) {
  record('SKIP', 'C6', 'profile patch 层挂着 knowself', `无 ${patchPath}`)
} else {
  const patched = /id:\s*knowself/.test(readFileSync(patchPath, 'utf8'))
  record(
    patched ? 'PASS' : 'FAIL',
    'C6',
    'profile patch 层挂着 knowself',
    patched ? 'patch 含 id: knowself' : '无 knowself → 插件静默不挂载（面板全无且不报错）',
  )
}

// C7 peer 版本对齐（官方是精确版本 + allow-version，不是范围匹配）
if (!pluginPkg) {
  record('SKIP', 'C7', 'peer 版本与运行时一致', 'C1 未通过')
} else {
  const declared = pluginPkg.peerDependencies?.[PEER_PROBE]
  const candidates = [
    join(profileDir, 'node_modules', PEER_PROBE, 'package.json'),
    join(electronDir, '..', PEER_PROBE, 'package.json'),
    join(pluginDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  ]
  const found = candidates.find((path) => existsSync(path))
  const actual = found ? readJson(found)?.version : undefined
  if (!declared) {
    record('WARN', 'C7', 'peer 版本与运行时一致', `插件未声明 ${PEER_PROBE}`)
  } else if (!actual) {
    record('SKIP', 'C7', 'peer 版本与运行时一致', `未找到 ${PEER_PROBE} 实体，无法比对`)
  } else if (actual === declared) {
    record('PASS', 'C7', 'peer 版本与运行时一致', `${PEER_PROBE} ${actual} = 声明值`)
  } else {
    record(
      'WARN',
      'C7',
      'peer 版本与运行时一致',
      `声明 ${declared}，实际 ${actual} → 装入时需 dsh plugin allow-version 显式豁免`,
    )
  }
}

// C9 profile 不得私带官方 runtime 核心包。它们应由 Desktop runtime 的 scoped
// resolver 提供；profile 内的旧 npm 副本会抢占 Node 解析并导致 per-agent persona
// 被误判为全局挂载，从而报重复 system prompt section。
{
  const packageRoot = join(profileDir, 'node_modules', '@deepseek-ai')
  const residual = PROFILE_FORBIDDEN_RUNTIME_COPIES.filter((name) =>
    existsSync(join(packageRoot, name, 'package.json')),
  )
  record(
    residual.length === 0 ? 'PASS' : 'FAIL',
    'C9',
    'profile 未覆盖 dsh runtime 核心包',
    residual.length === 0
      ? '未发现 @deepseek-ai runtime 实体副本'
      : `残留：${residual.join(', ')} → 用 scripts/repair-dsh-profile.mjs 重建 profile node_modules`,
  )
}

// C8 面板冒烟（可选，--smoke）：启动 Desktop → 连 CDP → 断言 6 图标与人物面板 → 截图
if (argv.includes('--smoke')) {
  const appDir = resolve(electronDir, '..', '..')
  const userDataDir = join(appDir, '.desktop-build', 'development', 'electron-user-data')
  const PANELS = ['人物', '图谱', '画像', '待整理', '日志', '资料']
  const shot = join(repoRoot, 'docs', 'dsh-integration', 'evidence', 'gate-smoke.png')

  if (!electronAbi) {
    record('SKIP', 'C8', '面板冒烟（6 图标 + 人物可用）', 'C3 未通过，无法启动')
  } else {
    const smokePort = 9223
    let child
    let childExit = ''
    try {
      const { spawn } = await import('node:child_process')
      const childLog = join(appDir, '.desktop-build', 'gate-smoke-child.log')
      const logFd = openSync(childLog, 'a')
      child = spawn(electronExe, [`--remote-debugging-port=${smokePort}`, `--user-data-dir=${userDataDir}`, appDir], {
        cwd: appDir,
        env: {
          ...cleanEnv(),
          DSH_HOME: join(homedir(), '.dsh'),
          KNOWSELF_ROOT_DIR: repoRoot,
          DSH_DESKTOP_PRIMARY_RUNTIME_DIR: join(appDir, '.desktop-build', 'targets', 'win-x64', 'runtime', 'primary-runtime'),
        },
        stdio: ['ignore', logFd, logFd],
      })
      child.on('error', (error) => {
        childExit = `error ${error.message}`
      })
      child.on('exit', (code, signal) => {
        childExit = `exit code=${code} signal=${signal}`
      })

      const deadline = Date.now() + 180_000
      let target
      while (Date.now() < deadline && !target) {
        try {
          const list = await (await fetch(`http://127.0.0.1:${smokePort}/json/list`, { signal: AbortSignal.timeout(5000) })).json()
          target = list.find((item) => String(item.url ?? '').startsWith('dsh-app://'))
        } catch {
          // CDP 还没起来
        }
        if (!target) await new Promise((done) => setTimeout(done, 3000))
      }
      if (!target) throw new Error(`180s 内未出现 dsh-app:// 页面（pid=${child?.pid} ${childExit}）`)

      const { chromium } = await import('playwright')
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${smokePort}`)
      const page = browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((item) => item.url().startsWith('dsh-app://'))
      if (!page) throw new Error('连上了 CDP 但没找到 dsh-app 页面')
      // Host 装配耗时可到 70s，必须等面板出现，不能固定 sleep
      let text = ''
      const panelDeadline = Date.now() + 150_000
      while (Date.now() < panelDeadline) {
        text = await page.evaluate(() => document.body.innerText)
        const ready = PANELS.every((name) => text.includes(name)) && !text.includes('Loading plugins')
        if (ready) break
        await page.waitForTimeout(3000)
      }
      await page.screenshot({ path: shot })
      await browser.close()

      const missing = PANELS.filter((name) => !text.includes(name))
      const problems = []
      if (missing.length > 0) problems.push(`缺图标：${missing.join('/')}`)
      if (text.includes('数据层未就绪')) problems.push('人物面板降级')
      if (text.includes('Could not locate the bindings file')) problems.push('原生模块未编好')
      if (text.includes('Loading plugins')) problems.push('Host 未完成装配')
      record(
        problems.length === 0 ? 'PASS' : 'FAIL',
        'C8',
        '面板冒烟（6 图标 + 人物可用）',
        problems.length === 0 ? `6 图标齐全；截图 ${shot}` : problems.join('；'),
      )
    } catch (error) {
      record('FAIL', 'C8', '面板冒烟（6 图标 + 人物可用）', String(error.message).split('\n')[0])
    } finally {
      if (child?.pid) {
        try {
          execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' })
        } catch {
          // 进程可能已自行退出
        }
      }
    }
  }
}

const failed = results.filter((item) => item.level === 'FAIL')
if (asJson) {
  process.stdout.write(`${JSON.stringify({ profile: profileName, results, failed: failed.length }, null, 2)}\n`)
} else {
  const width = Math.max(...results.map((item) => item.title.length))
  for (const item of results) {
    const mark = { PASS: '[PASS]', WARN: '[WARN]', FAIL: '[FAIL]', SKIP: '[SKIP]' }[item.level]
    process.stdout.write(`${mark} ${item.id} ${item.title.padEnd(width)}  ${item.detail}\n`)
  }
  process.stdout.write(
    `\n${failed.length === 0 ? '全绿' : `${failed.length} 项 FAIL`} / ${results.length} 项；` +
      `profile=${profileName}\n`,
  )
}
process.exit(failed.length === 0 ? 0 : 1)
