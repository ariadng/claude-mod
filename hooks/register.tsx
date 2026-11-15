import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { AgentRow, Ctx, Disk, Info, Limit, Res, Task, TaskStatus } from '../types'

const PANE = 'account-usage'
const info = atom({ plugin: 'session-hud', key: 'info' } as const, null, { shape: 'info-2' })
const effort = atom({ plugin: 'session-hud', key: 'effort' } as const, null)
const res = atom({ plugin: 'session-hud', key: 'res' } as const, null, { shape: 'res-3' })
const tasks = atom({ plugin: 'session-hud', key: 'tasks' } as const, [], { shape: 'tasks-1' })
const showAllTasks = atom({ plugin: 'session-hud', key: 'showAllTasks' } as const, false)
const agents = atom({ plugin: 'session-hud', key: 'agents' } as const, [], { shape: 'agents-2' })
const frame = atom({ plugin: 'session-hud', key: 'frame' } as const, 0)
const context = atom({ plugin: 'session-hud', key: 'context' } as const, null, { shape: 'ctx-2' })

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function home($: any): string | null {
  const i = $.plugin.root.indexOf('/.claude/')
  return i > 0 ? $.plugin.root.slice(0, i) : null
}

async function readJson($: any, path: string): Promise<any> {
  try {
    return JSON.parse(await $.fs.read(path))
  } catch {
    return {}
  }
}

// "claude-opus-5-5[1m]" -> "Opus 5.5"; anything unrecognised is shown as given.
function modelName(id: string | null): string | null {
  if (!id) return null
  const m = /(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/i.exec(id)
  if (!m) return id
  const [, f = '', major = '', minor = ''] = m
  const fam = f.charAt(0).toUpperCase() + f.slice(1).toLowerCase()
  return `${fam} ${major}${minor && minor.length <= 2 ? `.${minor}` : ''}`
}

function cap(s: string): string {
  return s === 'xhigh' ? 'XHigh' : s.charAt(0).toUpperCase() + s.slice(1)
}

function limit(v: any): Limit | null {
  return v && typeof v.utilization === 'number'
    ? { percent: v.utilization, resetsAt: v.resets_at ?? null }
    : null
}

async function fetchLimits($: any): Promise<{ fiveHour: Limit | null; weekly: Limit | null } | null> {
  try {
    const auth = await $.session.authorize()
    if (!auth || auth.kind !== 'bearer') return null
    const r = await $.http.fetch('https://api.anthropic.com/api/oauth/usage', {
      auth: auth.handle,
      headers: { 'anthropic-beta': 'oauth-2025-04-20' },
    })
    if (!r.ok) return null
    const d = JSON.parse(r.text)
    return { fiveHour: limit(d.five_hour), weekly: limit(d.seven_day) }
  } catch {
    return null
  }
}

async function refresh($: any) {
  const homeDir = home($)
  const [cfg, settings, model, api, live]: any[] = await Promise.all([
    homeDir ? readJson($, `${homeDir}/.claude.json`) : {},
    homeDir ? readJson($, `${homeDir}/.claude/settings.json`) : {},
    $.session.model().catch(() => null),
    fetchLimits($),
    $.session.usage().catch(() => null),
  ])
  let limits = api
  if (!limits) {
    const find = (k: string): Limit | null => {
      const w = (live?.rateLimits ?? []).find((x: any) => x.kind === k)
      return w ? { percent: w.percentUsed, resetsAt: w.resetsAt ?? null } : null
    }
    limits = { fiveHour: find('five_hour'), weekly: find('seven_day') }
  }
  // Until the first request reports the live effort, show the configured one.
  if ((await read($, effort)) === null && typeof settings.effortLevel === 'string') {
    await update($, effort, () => settings.effortLevel)
  }
  await setContext($, live?.context)
  const next: Info = { email: cfg.oauthAccount?.emailAddress ?? null, model, ...limits }
  await update($, info, () => next)
}

async function setContext($: any, c: any) {
  if (typeof c?.percent !== 'number' || typeof c?.window !== 'number') return
  const v: Ctx = { percent: Math.round(c.percent), window: c.window }
  const old = await read($, context)
  if (old?.percent !== v.percent || old?.window !== v.window) await update($, context, () => v)
}

// 1000000 -> "1M", 200000 -> "200K"
function tokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}

// Nerd Font glyphs: nf-fa-check, nf-fa-circle_o, nf-fa-times, nf-fa-stop, nf-fa-pause, nf-fa-tachometer, nf-fa-hdd_o, nf-fa-sitemap, nf-fa-folder, nf-dev-git_branch.
const ICON_DONE = '\uf00c'
const ICON_PENDING = '\uf10c'
const ICON_FAILED = '\uf00d'
const ICON_STOPPED = '\uf04d'
const ICON_PAUSED = '\uf04c'
const ICON_RESOURCES = '\uf0e4'
const ICON_DISK = '\uf0a0'
const ICON_NETWORK = '\uf0e8'
const ICON_FOLDER = '\uf07b'
const ICON_BRANCH = '\ue725'

// The machine's name, read once per load: the friendly name where the OS keeps
// one, else the hostname. Each command is tried in turn; one that is missing on
// this OS fails and the next is tried.
//   macOS:   scutil --get ComputerName   ("Alex’s MacBook Pro")
//   Linux:   hostnamectl --pretty        (set by the desktop; often empty)
//   Windows: hostname                    (the device name is the friendly name)
//   all:     hostname                    (as the OS reports it, domain kept)
const NAME_COMMANDS: string[][] = [
  ['scutil', '--get', 'ComputerName'],
  ['hostnamectl', '--pretty'],
  ['hostname'],
]
let hostCache: string | null = null
async function hostname($: any): Promise<string | null> {
  if (hostCache) return hostCache
  for (const argv of NAME_COMMANDS) {
    try {
      const r = await $.process.run(argv, { timeoutMs: 3000 })
      const name = r.exitCode === 0 ? r.stdout.trim() : ''
      if (name) {
        hostCache = name
        return hostCache
      }
    } catch {}
  }
  return null
}

// The machine's IPv4 address on the local network: the one its default route
// leaves from. Kept for 30 s so a network change shows within a refresh or two.
// Each way is tried in turn; one that is missing on this OS fails and the next
// is tried. None sends a packet: they only ask the routing table.
const IPV4 = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/
const usable = (a: string | undefined) =>
  !!a && !a.startsWith('127.') && !a.startsWith('169.254.') && a !== '0.0.0.0'
let ipCache: { value: string | null; at: number } | null = null

async function run($: any, argv: string[]): Promise<string> {
  try {
    const r = await $.process.run(argv, { timeoutMs: 3000 })
    return r.exitCode === 0 ? r.stdout : ''
  } catch {
    return ''
  }
}

async function localIp($: any): Promise<string | null> {
  const now = Date.now()
  if (ipCache && now - ipCache.at < 30_000) return ipCache.value
  const ways: (() => Promise<string | undefined>)[] = [
    // Linux (and macOS with iproute2mac): "1.1.1.1 via … dev en0 src 192.168.1.20"
    async () => /\bsrc (\S+)/.exec(await run($, ['ip', '-4', 'route', 'get', '1.1.1.1']))?.[1],
    // macOS: the default route's interface, then that interface's address
    async () => {
      const dev = /interface:\s*(\S+)/.exec(await run($, ['route', '-n', 'get', 'default']))?.[1]
      return dev ? IPV4.exec(await run($, ['ipconfig', 'getifaddr', dev]))?.[1] : undefined
    },
    // Windows: the IPv4 address of the adapter that has a default gateway
    async () =>
      IPV4.exec(
        await run($, [
          'powershell', '-NoProfile', '-Command',
          '(Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } | Select-Object -First 1).IPv4Address.IPAddress',
        ]),
      )?.[1],
    // Linux without iproute2: the first address the host has
    async () => IPV4.exec(await run($, ['hostname', '-I']))?.[1],
  ]
  let value: string | null = null
  for (const way of ways) {
    const a = await way()
    if (usable(a) && IPV4.test(a!)) {
      value = a!
      break
    }
  }
  ipCache = { value, at: now }
  return value
}

// ---- Tasks ----------------------------------------------------------------

async function tasksDir($: any): Promise<string | null> {
  const homeDir = home($)
  return homeDir ? `${homeDir}/.claude/tasks/${await $.session.id()}` : null
}

const byId = (a: { id: string }, b: { id: string }) =>
  Number(a.id) - Number(b.id) || a.id.localeCompare(b.id)

async function readTaskFiles($: any): Promise<any[]> {
  const dir = await tasksDir($)
  if (!dir) return []
  const entries = await $.fs.list(dir).catch(() => [])
  const files = entries.filter((x: any) => x.kind === 'file' && x.name.endsWith('.json'))
  const out: any[] = []
  for (const f of files) {
    try {
      out.push(JSON.parse(await $.fs.read(`${dir}/${f.name}`)))
    } catch {}
  }
  return out.filter(t => t && t.id != null).sort(byId)
}

let lastTasks = ''
async function syncTasks($: any) {
  const list: Task[] = (await readTaskFiles($))
    .filter(t => t.status !== 'deleted')
    .map(t => ({
      id: String(t.id),
      subject: String(t.subject ?? ''),
      activeForm: t.activeForm ?? null,
      status: (['pending', 'in_progress', 'completed'].includes(t.status) ? t.status : 'pending') as TaskStatus,
    }))
  hasActiveTask = list.some(t => t.status === 'in_progress')
  const key = JSON.stringify(list)
  if (key === lastTasks) return
  lastTasks = key
  await update($, tasks, () => list)
}

// Replays the conversation's own task calls, oldest first, into full task
// records as Claude Code writes them.
async function replayTranscript($: any): Promise<any[]> {
  const msgs = await $.session.messages()
  if (!Array.isArray(msgs)) return []
  const map = new Map<string, any>()
  for (const m of msgs) {
    for (const u of m.toolUses ?? []) {
      if (u.isError) continue
      const inp = u.input ?? {}
      if (u.tool === 'TaskCreate') {
        const id =
          (u.result as any)?.task?.id ?? /Task #(\w+) created/.exec(u.text ?? '')?.[1]
        if (id == null) continue
        map.set(String(id), {
          id: String(id),
          subject: inp.subject ?? '',
          description: inp.description ?? '',
          ...(inp.activeForm ? { activeForm: inp.activeForm } : {}),
          status: 'pending',
          blocks: [],
          blockedBy: [],
        })
      } else if (u.tool === 'TaskUpdate') {
        const t = map.get(String(inp.taskId))
        if (!t) continue
        if (inp.status === 'deleted') {
          map.delete(t.id)
          continue
        }
        for (const k of ['subject', 'description', 'activeForm', 'status', 'owner'] as const) {
          if (inp[k] !== undefined) t[k] = inp[k]
        }
        if (Array.isArray(inp.addBlocks)) t.blocks = [...new Set([...t.blocks, ...inp.addBlocks])]
        if (Array.isArray(inp.addBlockedBy)) t.blockedBy = [...new Set([...t.blockedBy, ...inp.addBlockedBy])]
      }
    }
  }
  return [...map.values()].sort(byId)
}

async function restoreTasks($: any) {
  const dir = await tasksDir($)
  if (!dir) return
  if ((await readTaskFiles($)).length > 0) return // this session already has its own
  const replayed = await replayTranscript($)
  if (replayed.length === 0) return // a new conversation: nothing to carry over
  if (!(await $.fs.exists(`${dir}/.lock`).catch(() => false))) await $.fs.write(`${dir}/.lock`, '')
  for (const t of replayed) {
    await $.fs.write(`${dir}/${t.id}.json`, JSON.stringify(t, null, 2))
  }
  $.ui.toast(`Restored ${replayed.length} task${replayed.length === 1 ? '' : 's'} from the conversation`)
}

// Which tasks to show in `max` rows: when there are too many, the oldest
// completed ones give way first, then the list is cut at the end.
function visibleTasks(list: Task[], max: number): Task[] {
  if (list.length <= max) return list
  let drop = list.length - max
  const keep = list.filter(t => {
    if (drop > 0 && t.status === 'completed') {
      drop -= 1
      return false
    }
    return true
  })
  return keep.slice(0, max)
}

const MAX_TASKS = 5

// ---- The working task's animation -----------------------------------------
// A braille spinner, and a lighter orange band that sweeps across the task's text and
// rests a moment before the next pass. One frame every 90 ms, and only while a
// task is in progress.
// A lighter tint of the theme's Claude orange (rgb 215,119,87), as Claude Code's
// own spinner shimmer uses.
const SHIMMER = '#EB9F7F'
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const FRAME_MS = 90
const SWEEP = 3 // characters lit at once
const REST = 12 // frames between passes

function fit(text: string, room: number): string {
  return text.length <= room ? text : `${text.slice(0, room - 1)}…`
}

// The text in up to three runs: before, under and after the lit window.
function shimmer(text: string, tick: number): { text: string; lit: boolean }[] {
  const cycle = text.length + SWEEP + REST
  const head = (tick % cycle) - SWEEP // the window's left edge
  const a = Math.max(0, Math.min(text.length, head))
  const b = Math.max(0, Math.min(text.length, head + SWEEP))
  return [
    { text: text.slice(0, a), lit: false },
    { text: text.slice(a, b), lit: true },
    { text: text.slice(b), lit: false },
  ].filter(p => p.text.length > 0)
}

let hasActiveTask = false

// ---- Subagents --------------------------------------------------------------
// $.agent.list() holds the session's agents until the engine drops a finished
// one's task (seconds to minutes later); keep every one seen, with its last
// status, so the section is a history of this session's subagents.
let hasRunningAgent = false
const agentModels = new Map<string, string>()
let lastAgents = ''
const LIVE = new Set(['pending', 'running', 'waiting', 'idle'])

async function syncAgents($: any) {
  const now = Date.now()
  const live: any[] = await $.agent.list().catch(() => [])
  const old = await read($, agents)
  const byId = new Map(old.map(a => [a.id, a]))
  for (const a of live) {
    const prev = byId.get(a.id)
    byId.set(a.id, {
      id: a.id,
      name: a.name || a.type || 'agent',
      model: agentModels.get(a.id) ?? prev?.model ?? null,
      description: a.description || '',
      type: a.type,
      status: a.status,
      seenAt: prev?.seenAt ?? now,
    })
  }
  // One the engine dropped while we last saw it live has ended unseen.
  const liveIds = new Set(live.map(a => a.id))
  for (const [id, a] of byId) {
    if (!liveIds.has(id) && LIVE.has(a.status)) byId.set(id, { ...a, status: 'completed' })
  }
  const list = [...byId.values()].sort((a, b) => a.seenAt - b.seenAt)
  hasRunningAgent = list.some(a => a.status === 'running' || a.status === 'pending')
  const key = JSON.stringify(list)
  if (key === lastAgents) return
  lastAgents = key
  await update($, agents, () => list)
}

// Which agents to show in `max` rows: finished ones give way first.
function visibleAgents(list: AgentRow[], max: number): AgentRow[] {
  if (list.length <= max) return list
  let drop = list.length - max
  return list
    .filter(a => {
      if (drop > 0 && !LIVE.has(a.status)) {
        drop -= 1
        return false
      }
      return true
    })
    .slice(-max)
}

// CPU and RAM, sampled every few seconds. The OS is found once, by which
// source answers: /proc (Linux), vm_stat (macOS), PowerShell (Windows).
type Os = 'linux' | 'mac' | 'windows' | 'none'
let os: Os | null = null
let prevStat: { idle: number; total: number } | null = null

async function detectOs($: any): Promise<Os> {
  if (await $.fs.exists('/proc/stat').catch(() => false)) return 'linux'
  if (await run($, ['vm_stat'])) return 'mac'
  if (await run($, ['powershell', '-NoProfile', '-Command', 'echo ok'])) return 'windows'
  return 'none'
}

async function sampleLinux($: any): Promise<Omit<Res, 'disk'>> {
  const stat = await $.fs.read('/proc/stat').catch(() => '')
  const f = (/^cpu\s+(.+)$/m.exec(stat)?.[1] ?? '').trim().split(/\s+/).map(Number)
  let cpu: number | null = null
  if (f.length >= 4) {
    const idle = (f[3] ?? 0) + (f[4] ?? 0)
    const total = f.reduce((a, b) => a + b, 0)
    if (prevStat && total > prevStat.total) {
      cpu = (1 - (idle - prevStat.idle) / (total - prevStat.total)) * 100
    }
    prevStat = { idle, total }
  }
  const mem = await $.fs.read('/proc/meminfo').catch(() => '')
  const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(mem)?.[1] ?? NaN)
  const total = kb('MemTotal')
  const avail = kb('MemAvailable')
  return {
    cpu,
    ramUsed: Number.isFinite(total - avail) ? (total - avail) * 1024 : null,
    ramTotal: Number.isFinite(total) ? total * 1024 : null,
  }
}

async function sampleMac($: any): Promise<Omit<Res, 'disk'>> {
  // top's second sample covers the last second; the first is since boot.
  const [top, vm, sys] = await Promise.all([
    run($, ['top', '-l', '2', '-n', '0', '-s', '1']),
    run($, ['vm_stat']),
    run($, ['sysctl', '-n', 'hw.memsize']),
  ])
  const idles = [...top.matchAll(/([\d.]+)% idle/g)]
  const idle = Number(idles[idles.length - 1]?.[1] ?? NaN)
  const page = Number(/page size of (\d+)/.exec(vm)?.[1] ?? 4096)
  const pages = (k: string) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(vm)?.[1] ?? 0)
  // Activity Monitor's "Memory Used": app memory + wired + compressed.
  const used = (pages('Anonymous pages') - pages('Pages purgeable') + pages('Pages wired down') +
    pages('Pages occupied by compressor')) * page
  const total = Number(sys.trim())
  return {
    cpu: Number.isFinite(idle) ? 100 - idle : null,
    ramUsed: used > 0 ? used : null,
    ramTotal: total > 0 ? total : null,
  }
}

async function sampleWindows($: any): Promise<Omit<Res, 'disk'>> {
  const out = await run($, [
    'powershell', '-NoProfile', '-Command',
    '$c=(Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average;' +
      '$o=Get-CimInstance Win32_OperatingSystem;' +
      '"$c $($o.TotalVisibleMemorySize) $($o.FreePhysicalMemory)"',
  ])
  const [c, t, f] = out.trim().split(/\s+/).map(Number)
  const ok = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n)
  return {
    cpu: ok(c) ? c : null,
    ramUsed: ok(t) && ok(f) ? (t - f) * 1024 : null,
    ramTotal: ok(t) ? t * 1024 : null,
  }
}

let sampling = false
async function sampleResources($: any) {
  if (sampling) return
  sampling = true
  try {
    os ??= await detectOs($)
    const base =
      os === 'linux' ? await sampleLinux($)
      : os === 'mac' ? await sampleMac($)
      : os === 'windows' ? await sampleWindows($)
      : null
    if (base) {
      const r: Res = { ...base, disk: await diskUsage($, os) }
      await update($, res, () => r)
    }
  } finally {
    sampling = false
  }
}

// Whether a volume sits on a solid-state or a spinning disk; null when the OS
// does not say (a network share, a disk image). Kept per device: it never changes.
//   macOS:   diskutil info <device>  -> "Solid State: Yes"
//   Linux:   lsblk -s: ROTA of the device and every disk under it (1 = spinning)
//   Windows: the MediaType of the physical disk holding the drive letter
const kindCache = new Map<string, 'SSD' | 'HDD' | null>()
async function diskKind($: any, os: Os, device: string): Promise<'SSD' | 'HDD' | null> {
  if (kindCache.has(device)) return kindCache.get(device)!
  let kind: 'SSD' | 'HDD' | null = null
  if (os === 'mac' && device.startsWith('/dev/')) {
    const m = /Solid State:\s*(Yes|No)/.exec(await run($, ['diskutil', 'info', device]))
    if (m) kind = m[1] === 'Yes' ? 'SSD' : 'HDD'
  } else if (os === 'linux' && device.startsWith('/dev/')) {
    const flags = (await run($, ['lsblk', '-sno', 'ROTA', device])).split(/\s+/).filter(Boolean)
    if (flags.length) kind = flags.includes('1') ? 'HDD' : 'SSD'
  } else if (os === 'windows') {
    const out = await run($, [
      'powershell', '-NoProfile', '-Command',
      `$n=(Get-Partition -DriveLetter ${device}).DiskNumber;(Get-PhysicalDisk | Where-Object DeviceId -eq $n).MediaType`,
    ])
    const m = /\b(SSD|HDD)\b/.exec(out)
    if (m) kind = m[1] as 'SSD' | 'HDD'
  }
  kindCache.set(device, kind)
  return kind
}

// The volume or partition the working directory is on: used = size - available,
// which on APFS counts every volume sharing the space, as Finder does. Disk
// usage moves slowly: read every 30 s, or at once when the directory changes.
//   macOS, Linux: df -k <working dir>
//   Windows:      PowerShell, the working directory's drive letter
let diskCache: { cwd: string; value: Disk | null; at: number } | null = null
async function diskUsage($: any, kind: Os): Promise<Disk | null> {
  const now = Date.now()
  const cwd: string = await $.session.cwd()
  if (diskCache && diskCache.cwd === cwd && now - diskCache.at < 30_000) return diskCache.value
  let value: Disk | null = null
  if (kind === 'mac' || kind === 'linux') {
    const out = await run($, ['df', '-k', cwd])
    const row = out.trim().split('\n').pop()?.trim().split(/\s+/) ?? []
    const size = Number(row[1]) * 1024
    const avail = Number(row[3]) * 1024
    if (size > 0 && Number.isFinite(avail)) {
      value = { used: size - avail, total: size, kind: await diskKind($, kind, row[0] ?? '') }
    }
  } else if (kind === 'windows') {
    const drive = /^([A-Za-z]):/.exec(cwd)?.[1]?.toUpperCase()
    const out = drive
      ? await run($, [
          'powershell', '-NoProfile', '-Command',
          `$d=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive}:'";"$($d.Size) $($d.FreeSpace)"`,
        ])
      : ''
    const [size, free] = out.trim().split(/\s+/).map(Number)
    if (drive && size && size > 0 && Number.isFinite(free)) {
      value = { used: size - free!, total: size, kind: await diskKind($, kind, drive) }
    }
  }
  diskCache = { cwd, value, at: now }
  return value
}

// A percentage padded to 3 characters (" 6%", "65%"), so a change in its digit
// count doesn't shift what follows; 100% alone takes a fourth.
function pct(n: number): string {
  return `${String(Math.round(n)).padStart(2)}%`
}


// The branch name, or the short commit on a detached HEAD; null outside a repo.
let branchCache: { cwd: string; value: string | null; at: number } | null = null
async function gitBranch($: any, cwd: string): Promise<string | null> {
  const now = Date.now()
  if (branchCache && branchCache.cwd === cwd && now - branchCache.at < 5_000) return branchCache.value
  const value = await readBranch($, cwd)
  branchCache = { cwd, value, at: now }
  return value
}

async function readBranch($: any, cwd: string): Promise<string | null> {
  try {
    const r = await $.process.run(['git', 'symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd, timeoutMs: 3000 })
    if (r.exitCode === 0 && r.stdout.trim()) return r.stdout.trim()
    const sha = await $.process.run(['git', 'rev-parse', '--short', 'HEAD'], { cwd, timeoutMs: 3000 })
    return sha.exitCode === 0 && sha.stdout.trim() ? `(${sha.stdout.trim()})` : null
  } catch {
    return null
  }
}

function clock(d: Date): string {
  const hour = d.getHours() % 12 || 12
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${hour}:${m}${d.getHours() < 12 ? 'AM' : 'PM'}`
}

// Today: "2:49PM"; another day: "Nov 16 3:59AM".
function resetAt(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const sameDay = new Date().toDateString() === d.toDateString()
  return sameDay ? clock(d) : `${MONTHS[d.getMonth()]} ${d.getDate()} ${clock(d)}`
}

function color(p: number): string {
  return p >= 90 ? 'red' : p >= 70 ? 'yellow' : 'green'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'account-usage', description: 'Refresh the account and usage line' })
    $.ui.status(undefined)
    void $.ui.open({ id: PANE, title: 'Pane', columns: 30 })
    void refresh($)
    $.clock.every(60_000, () => void refresh($))
    void sampleResources($)
    $.clock.every(3_000, () => void sampleResources($))
    // A resumed conversation gets a new session id, and with it an empty task
    // folder: put back the tasks its transcript made, so Claude and the pane
    // both have them, under the same ids the conversation refers to.
    await restoreTasks($).catch(() => {})
    void syncTasks($)
    $.clock.every(2_000, () => void syncTasks($))
    void syncAgents($)
    $.clock.every(1_000, () => void syncAgents($))
    $.clock.every(FRAME_MS, () => {
      if (hasActiveTask || hasRunningAgent) void update($, frame, n => (n + 1) % 1_000_000)
    })
    return next(e)
  })

  on('command.run', { command: 'account-usage' }, async $ => {
    await refresh($)
    return { text: 'Account and usage line refreshed.' }
  })

  // The main loop's requests carry the effort actually in force.
  on('turn.step', async function* ($, e, next) {
    // A subagent's requests name the model it runs on.
    if (e.agentId !== undefined && e.model) agentModels.set(e.agentId, e.model)
    if (e.agentId === undefined && typeof e.effort === 'string') {
      const level = e.effort
      if ((await read($, effort)) !== level) await update($, effort, () => level)
    }
    return yield* next(e)
  })

  // Fires whenever the status line's figures change: keeps Context live mid-turn.
  on('session.measure', async ($, e, next) => {
    await setContext($, e.context)
    return next(e)
  })

  // The task list. Claude Code keeps it as files, one per task, under
  // ~/.claude/tasks/<session id>/; read them after each task call and on a timer
  // (a subagent's calls write there too).
  const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])
  on('tool.call', async ($, e, next) => {
    if (!TASK_TOOLS.has(e.tool)) return next(e)
    const r = await next(e)
    void syncTasks($)
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    void refresh($)
    return r
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const v = await read($, info)
    if (!v) return next(e)
    const lvl = await read($, effort)
    const ctx = await read($, context)
    const { Box, Text } = $.ui.resolve(e)
    const dot = <Text dimColor> • </Text>
    const model = [modelName(v.model), lvl ? cap(lvl) : null].filter(Boolean).join(' ')
    const lim = (name: string, l: Limit | null) =>
      l && (
        <Box flexDirection="row">
          {dot}
          <Text>{name} </Text>
          <Text color={color(l.percent)}>{Math.round(l.percent)}%</Text>
          {l.resetsAt ? <Text dimColor> {resetAt(l.resetsAt)}</Text> : null}
        </Box>
      )
    return (
      <Box flexDirection="row">
        <Text>{v.email ?? 'unknown account'}</Text>
        {model ? dot : null}
        {model ? <Text>{model}</Text> : null}
        {lim('5H', v.fiveHour)}
        {lim('Weekly', v.weekly)}
        {ctx !== null && (
          <Box flexDirection="row">
            {dot}
            <Text>Context </Text>
            <Text color={color(ctx.percent)}>{ctx.percent}%</Text>
            <Text> of {tokens(ctx.window)}</Text>
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    // Reading the info atom redraws the pane on each refresh (every minute and
    // after each turn), which picks up a changed working directory.
    await read($, info)
    const r = await read($, res)
    const list = await read($, tasks)
    const showAll = await read($, showAllTasks)
    const shown = showAll ? list : visibleTasks(list, MAX_TASKS)
    const hidden = list.length - shown.length
    const tick = await read($, frame)
    const agentList = await read($, agents)
    const agentsShown = showAll ? agentList : visibleAgents(agentList, MAX_TASKS)
    const agentsHidden = agentList.length - agentsShown.length
    // The row's text room: the pane body less its padding and the icon's 3.
    const room = Math.max(4, (e.props.bodyColumns ?? 30) - 2 - 3)
    const homeDir = home($)
    const raw = await $.session.cwd()
    const branch = await gitBranch($, raw)
    const host = await hostname($)
    const ip = await localIp($)
    const cwd = homeDir && (raw === homeDir || raw.startsWith(homeDir + "/")) ? "~" + raw.slice(homeDir.length) : raw
    // Theme keys follow the person's light or dark theme.
    const header = (title: string) => (
      <Box backgroundColor="subtle" paddingX={1} marginBottom={1} width="100%">
        <Text bold color="text" wrap="truncate-end">{title}</Text>
      </Box>
    )
    return (
      <Box paddingX={1} flexDirection="column">
        {header(host ?? 'This Computer')}
        <Box flexDirection="row">
          <Text>{ICON_NETWORK}  </Text>
          {ip ? <Text>{ip}</Text> : <Text dimColor>offline</Text>}
        </Box>
        <Box flexDirection="row">
          <Text>{ICON_RESOURCES}  </Text>
          <Text>CPU </Text>
          {r?.cpu != null ? (
            <Text color={color(r.cpu)}>{pct(r.cpu)}</Text>
          ) : (
            <Text dimColor>{' — '}</Text>
          )}
          <Text>  RAM </Text>
          {r?.ramUsed != null && r.ramTotal != null ? (
            <Text color={color((r.ramUsed / r.ramTotal) * 100)}>{pct((r.ramUsed / r.ramTotal) * 100)}</Text>
          ) : (
            <Text dimColor>—</Text>
          )}
        </Box>
        <Box flexDirection="row">
          <Text>{ICON_DISK}  </Text>
          <Text>{r?.disk?.kind ?? 'DSK'} </Text>
          {r?.disk ? (
            <Text color={color((r.disk.used / r.disk.total) * 100)}>
              {pct((r.disk.used / r.disk.total) * 100)}
            </Text>
          ) : (
            <Text dimColor>—</Text>
          )}
        </Box>
        <Box marginTop={1} />
        {header('This Project')}
        <Box flexDirection="row">
          <Text>{ICON_FOLDER}  </Text>
          <Text wrap="truncate-start">{cwd}</Text>
        </Box>
        <Box flexDirection="row">
          <Text>{ICON_BRANCH}  </Text>
          {branch ? (
            <Text wrap="truncate-end">{branch}</Text>
          ) : (
            <Text dimColor>not a git repo</Text>
          )}
        </Box>
        <Box marginTop={1} />
        {header('Progress')}
        {list.length === 0 && <Text dimColor>No tasks yet</Text>}
        {shown.map(t =>
          t.status === 'completed' ? (
            <Box flexDirection="row">
              <Text color="success">{ICON_DONE}  </Text>
              <Text dimColor strikethrough wrap="truncate-end">{t.subject}</Text>
            </Box>
          ) : t.status === 'in_progress' ? (
            <Box flexDirection="row">
              <Text color="claude">{SPINNER[tick % SPINNER.length]}  </Text>
              {shimmer(fit(t.activeForm ?? t.subject, room), tick).map(p => (
                <Text color={p.lit ? SHIMMER : 'claude'}>{p.text}</Text>
              ))}
            </Box>
          ) : (
            <Box flexDirection="row">
              <Text dimColor>{ICON_PENDING}  </Text>
              <Text wrap="truncate-end">{t.subject}</Text>
            </Box>
          ),
        )}
        {hidden > 0 && <Text dimColor>{hidden} more</Text>}
        <Box marginTop={1} />
        {header('Subagents')}
        {agentList.length === 0 && <Text dimColor>No subagents yet</Text>}
        {agentsShown.map(a => {
          // Row 1: model and name, in the theme's text color (white on dark); row 2: what it was asked to do, dim, under the text.
          const model = a.model ? modelName(a.model) : null
          const title = fit(model ? `${model} · ${a.name}` : a.name, room)
          const desc = a.description ? (
            <Text dimColor>{'   '}{fit(a.description, room)}</Text>
          ) : null
          if (a.status === 'running' || a.status === 'pending') {
            return (
              <Box flexDirection="column">
                <Box flexDirection="row">
                  <Text color="claude">{SPINNER[tick % SPINNER.length]}  </Text>
                  {shimmer(title, tick).map(p => (
                    <Text color="text" dimColor={p.lit}>{p.text}</Text>
                  ))}
                </Box>
                {desc}
              </Box>
            )
          }
          const [icon, iconColor] =
            a.status === 'completed' ? [ICON_DONE, 'success']
            : a.status === 'failed' ? [ICON_FAILED, 'error']
            : a.status === 'killed' ? [ICON_STOPPED, 'inactive']
            : [ICON_PAUSED, 'warning'] // waiting, idle
          return (
            <Box flexDirection="column">
              <Box flexDirection="row">
                <Text color={iconColor}>{icon}  </Text>
                <Text color="text">{title}</Text>
              </Box>
              {desc}
            </Box>
          )
        })}
        {agentsHidden > 0 && <Text dimColor>{agentsHidden} more</Text>}
        {(hidden > 0 || agentsHidden > 0 || (showAll && (list.length > MAX_TASKS || agentList.length > MAX_TASKS))) && (
          <Box marginTop={1}>
            <Button
              key="show-all-toggle"
              // ctrl+t: Claude Code's own "toggle task list" shortcut, whatever the
              // person has bound it to; t while the pane holds the keyboard.
              action="app:toggleTodos"
              hotkey="t"
              plain
              dimColor
              label={showAll ? 'show fewer' : 'show all'}
              onPress={() => update($, showAllTasks, v => !v)}
            />
          </Box>
        )}
      </Box>
    )
  })
}
