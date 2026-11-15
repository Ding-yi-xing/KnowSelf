#!/usr/bin/env node
/**
 * Rebuild a dsh Desktop profile whose historical npm installation materialized
 * @deepseek-ai runtime peers inside profile node_modules.
 *
 * Usage:
 *   node scripts/repair-dsh-profile.mjs --tarball C:/path/knowself-dsh-plugin-0.5.2.tgz
 *   node scripts/repair-dsh-profile.mjs --apply --tarball C:/path/knowself-dsh-plugin-0.5.2.tgz
 *
 * The Desktop application must be fully stopped before --apply. The prior
 * node_modules tree is renamed, not deleted, so it remains available for a
 * deliberate rollback until the repair has been accepted.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'

const RUNTIME_CORE_PACKAGES = [
  'cordis',
  'dsh-agent',
  'dsh-scope',
  'dsh-session',
  'dsh-settings',
  'dsh-system-prompt',
  'dsh-tools',
]

const argv = process.argv.slice(2)
const argOf = (name, fallback = undefined) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? fallback : argv[index + 1]
}
const apply = argv.includes('--apply')
const profileName = argOf('profile', 'desktop')
const dshHome = resolve(argOf('dsh-home', process.env.DSH_HOME || join(homedir(), '.dsh')))
const profileDir = resolve(argOf('profile-dir', join(dshHome, 'profiles', profileName)))
const tarball = argOf('tarball')

function fail(message) {
  process.stderr.write(`[repair-dsh-profile] ${message}\n`)
  process.exitCode = 1
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function timestamp() {
  return new Date().toISOString().replaceAll(':', '').replaceAll('.', '')
}

function readTarballPackage(path) {
  const archive = gunzipSync(readFileSync(path))
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512)
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    if (name === '') break
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    const fullName = prefix === '' ? name : `${prefix}/${name}`
    const rawSize = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim()
    const size = Number.parseInt(rawSize || '0', 8)
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`invalid tar entry size for ${fullName}`)
    const contentOffset = offset + 512
    if (fullName === 'package/package.json') {
      return JSON.parse(archive.subarray(contentOffset, contentOffset + size).toString('utf8'))
    }
    offset = contentOffset + Math.ceil(size / 512) * 512
  }
  throw new Error('package/package.json is missing from tarball')
}

function runtimeCoreCopies(root) {
  const packageRoot = join(root, 'node_modules', '@deepseek-ai')
  return RUNTIME_CORE_PACKAGES.filter((name) => existsSync(join(packageRoot, name, 'package.json')))
}

function copyIfPresent(source, destination) {
  if (!existsSync(source)) return false
  copyFileSync(source, destination)
  return true
}

function profilePackageSpec(path) {
  return `file:${path.replaceAll('\\', '/')}`
}

function writeProfilePackage(path, tarballPath) {
  const current = readJson(path)
  const dependencies = { ...(current.dependencies ?? {}) }
  dependencies['@knowself/dsh-plugin'] = profilePackageSpec(tarballPath)
  writeFileSync(path, `${JSON.stringify({ ...current, dependencies }, null, 2)}\n`, 'utf8')
}

function ensureWorkspaceConfig(path) {
  const content = [
    'packages:',
    '  - .',
    'nodeLinker: hoisted',
    'autoInstallPeers: false',
    'allowBuilds:',
    '  better-sqlite3: true',
    '  better-sqlite3-multiple-ciphers: true',
    '',
  ].join('\n')
  writeFileSync(path, content, 'utf8')
}

function runPnpm(profile) {
  const command = process.platform === 'win32' ? 'cmd.exe' : 'pnpm'
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'pnpm install --offline --no-frozen-lockfile']
    : ['install', '--offline', '--no-frozen-lockfile']
  execFileSync(command, args, {
    cwd: profile,
    stdio: 'inherit',
    windowsHide: true,
  })
}

function main() {
  if (!existsSync(join(profileDir, 'package.json'))) {
    fail(`profile does not exist: ${profileDir}`)
    return
  }
  if (tarball === undefined) {
    fail('missing --tarball <absolute path>')
    return
  }
  const tarballPath = resolve(tarball)
  if (!existsSync(tarballPath)) {
    fail(`tarball does not exist: ${tarballPath}`)
    return
  }

  let tarballPackage
  try {
    tarballPackage = readTarballPackage(tarballPath)
  } catch (error) {
    fail(`cannot read plugin tarball: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  if (tarballPackage.name !== '@knowself/dsh-plugin' || typeof tarballPackage.version !== 'string') {
    fail('tarball is not a versioned @knowself/dsh-plugin package')
    return
  }

  const before = runtimeCoreCopies(profileDir)
  const installedPath = join(profileDir, 'node_modules', '@knowself', 'dsh-plugin', 'package.json')
  const installed = existsSync(installedPath) ? readJson(installedPath) : undefined
  const plan = {
    profile: profileDir,
    tarball: tarballPath,
    tarballVersion: tarballPackage.version,
    installedVersion: installed?.version ?? null,
    runtimeCoreCopiesBefore: before,
    action: apply ? 'apply' : 'inspect',
  }
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
  if (!apply) {
    process.stdout.write('[repair-dsh-profile] read-only. Stop Desktop, then rerun with --apply after reviewing this plan.\n')
    return
  }

  const backupRoot = join(profileDir, '.knowself-repair-backups', `persona-${timestamp()}`)
  mkdirSync(backupRoot, { recursive: true })
  const preserved = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml', 'settings.json'].filter(
    (file) => copyIfPresent(join(profileDir, file), join(backupRoot, file)),
  )
  writeFileSync(
    join(backupRoot, 'repair-manifest.json'),
    `${JSON.stringify({ ...plan, preserved, appliedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  )

  const moduleDir = join(profileDir, 'node_modules')
  const quarantine = join(profileDir, `node_modules.pre-persona-repair-${timestamp()}`)
  if (existsSync(moduleDir)) renameSync(moduleDir, quarantine)
  try {
    writeProfilePackage(join(profileDir, 'package.json'), tarballPath)
    ensureWorkspaceConfig(join(profileDir, 'pnpm-workspace.yaml'))
    runPnpm(profileDir)
  } catch (error) {
    process.stderr.write(
      `[repair-dsh-profile] repair did not complete. Original modules remain at ${quarantine}.\n` +
        `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    )
    process.exitCode = 1
    return
  }

  const after = runtimeCoreCopies(profileDir)
  const repairedPath = join(profileDir, 'node_modules', '@knowself', 'dsh-plugin', 'package.json')
  const repaired = existsSync(repairedPath) ? readJson(repairedPath) : undefined
  if (after.length > 0 || repaired?.version !== tarballPackage.version) {
    process.stderr.write(
      `[repair-dsh-profile] validation failed; prior modules remain at ${quarantine}. ` +
        `core copies=${after.join(', ') || 'none'} plugin=${repaired?.version ?? 'missing'}\n`,
    )
    process.exitCode = 1
    return
  }
  process.stdout.write(
    `[repair-dsh-profile] profile rebuilt with @knowself/dsh-plugin@${repaired.version}.\n` +
      `[repair-dsh-profile] prior modules retained at ${quarantine}.\n` +
      '[repair-dsh-profile] next run: node scripts/dsh-upgrade-check.mjs (then --smoke after it is green).\n',
  )
}

main()
