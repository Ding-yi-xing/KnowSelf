#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { homedir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(join(fileURLToPath(new URL('.', import.meta.url)), '..'))
const pluginRoot = join(repoRoot, 'dsh', 'knowself')
const profileRoot = resolve(
  option('profile-dir', join(homedir(), '.dsh', 'profiles', 'desktop')),
)
const tarball = option('tarball')
const roots = ['dist/bundle', 'dist/client-bundle']
const failures = []

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? fallback : process.argv[index + 1]
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function collectFiles(root, prefix, clientOnly = false) {
  const files = new Map()
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile()) {
        const key = `${prefix}${relative(root, absolute).split(sep).join('/')}`
        if (clientOnly && key !== 'dist/client-bundle/client.js') continue
        files.set(key, sha256(readFileSync(absolute)))
      }
    }
  }
  visit(root)
  return files
}

function parseTarball(path) {
  const archive = gunzipSync(readFileSync(path))
  const files = new Map()
  let offset = 0
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = field(header, 0, 100)
    const prefix = field(header, 345, 155)
    const fullName = [prefix, name].filter(Boolean).join('/')
    const size = Number.parseInt(field(header, 124, 12).trim() || '0', 8)
    const start = offset + 512
    const content = archive.subarray(start, start + size)
    const packagePath = fullName.startsWith('package/') ? fullName.slice(8) : fullName
    if (roots.some((root) => packagePath.startsWith(`${root}/`))) {
      files.set(packagePath, sha256(content))
    }
    offset = start + Math.ceil(size / 512) * 512
  }
  return files
}

function field(buffer, start, length) {
  return buffer.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '').trim()
}

function compare(label, expected, actual) {
  const missing = [...expected.keys()].filter((key) => !actual.has(key))
  const extra = [...actual.keys()].filter((key) => !expected.has(key))
  const changed = [...expected.keys()].filter((key) => actual.has(key) && expected.get(key) !== actual.get(key))
  const ok = missing.length === 0 && extra.length === 0 && changed.length === 0
  process.stdout.write(`${ok ? '[PASS]' : '[FAIL]'} ${label}: expected=${expected.size} actual=${actual.size}\n`)
  for (const key of missing) process.stdout.write(`  missing: ${key}\n`)
  for (const key of extra) process.stdout.write(`  extra: ${key}\n`)
  for (const key of changed) process.stdout.write(`  sha256 differs: ${key}\n`)
  if (!ok) failures.push(label)
}

const repoFiles = new Map()
for (const root of roots) {
  const absolute = join(pluginRoot, root)
  if (!existsSync(absolute)) {
    failures.push(`repo ${root} missing`)
    process.stdout.write(`[FAIL] repo bundle missing: ${absolute}\n`)
    continue
  }
  const entries = collectFiles(absolute, `${root}/`, root === 'dist/client-bundle')
  for (const [path, digest] of entries) repoFiles.set(path, digest)
}
if (!repoFiles.has('dist/client-bundle/client.js')) {
  failures.push('repo client bundle missing')
  process.stdout.write('[FAIL] repo bundle missing: dist/client-bundle/client.js\n')
}

if (tarball) {
  const tarballPath = resolve(tarball)
  if (!existsSync(tarballPath)) {
    failures.push('tarball missing')
    process.stdout.write(`[FAIL] tarball missing: ${tarballPath}\n`)
  } else {
    compare('repo -> tgz', repoFiles, parseTarball(tarballPath))
  }
} else {
  process.stdout.write('[SKIP] repo -> tgz: pass --tarball <path>\n')
}

const installedRoot = join(profileRoot, 'node_modules', '@knowself', 'dsh-plugin')
if (!existsSync(installedRoot)) {
  failures.push('profile plugin missing')
  process.stdout.write(`[FAIL] profile plugin missing: ${installedRoot}\n`)
} else {
  const installedFiles = new Map()
  for (const root of roots) {
    const absolute = join(installedRoot, root)
    if (!existsSync(absolute)) continue
    for (const [path, digest] of collectFiles(absolute, `${root}/`, root === 'dist/client-bundle')) {
      installedFiles.set(path, digest)
    }
  }
  compare('repo -> Desktop profile', repoFiles, installedFiles)
}

process.exitCode = failures.length === 0 ? 0 : 1
