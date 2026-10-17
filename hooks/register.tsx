import type { EngineInterface, Register } from 'claude-code'

const PANE = 'doom'
/** DOOM's own width in cells: 320 pixels, two a cell. */
const MAX_CELL_COLUMNS = 160
/** An Image is at most 255 cells either way. */
const MAX_IMAGE_COLUMNS = 255

type Size = { columns: number; rows: number }
type Mode = 'cells' | 'pixels'

type Frame =
  | (Size & { kind: 'cells'; cells: string })
  | { kind: 'pixels'; width: number; height: number; generation: number; path: string }

type Game = {
  mode: Mode
  /** Why the game draws as it does, shown under the picture. */
  note: string
  /** When the pane first drew the Image, epoch ms: a refusal before it settles is no answer. */
  imageSince?: number
  /** The cell size last asked of the game; cell frames follow it a moment later. */
  wanted: Size
  /** The newest frame. */
  frame?: Frame
  /** The size of the Raster the pane last drew: cell frames of another size need a redraw. */
  mounted?: Size
  isStopped: boolean
  error?: string
  /** The keys file's last lines: "<seq> <key>", "<seq> size <columns> <rows>" or "<seq> mode <mode>". */
  lines: string[]
  lineCount: number
  /** The newest key press already passed on, by the keyboard's own numbering. */
  lastKeySeq: number
  keysPath: string
}

let game: Game | undefined
let isBlitting = false
let pending: Frame | undefined

/** The picture's size in cells: as wide as the pane allows, 4:3, a cell twice as tall as wide. */
const sizeFor = (bodyColumns: number, bodyRows: number, maxColumns: number): Size => {
  let columns = Math.min(bodyColumns, maxColumns)
  let rows = Math.round((columns * 3) / 8)
  const roomRows = Math.max(4, bodyRows - 4)
  if (rows > roomRows) {
    rows = roomRows
    columns = Math.round((rows * 8) / 3)
  }
  return { columns: Math.max(8, columns), rows: Math.max(4, rows) }
}

const isSameSize = (a: Size | undefined, b: Size) => a !== undefined && a.columns === b.columns && a.rows === b.rows

/** One stdout line of the game: "<columns> <rows> <cells>" or "P <width> <height> <generation> <path>". */
const parseFrame = (line: string): Frame | undefined => {
  const pixels = /^P (\d+) (\d+) (\d+) (.+?)\r?$/.exec(line)
  if (pixels !== null) {
    return { kind: 'pixels', width: Number(pixels[1]), height: Number(pixels[2]), generation: Number(pixels[3]), path: pixels[4] ?? '' }
  }
  const cells = /^(\d+) (\d+) ([A-Za-z0-9+/=]+)\r?$/.exec(line)
  if (cells === null) return undefined
  return { kind: 'cells', columns: Number(cells[1]), rows: Number(cells[2]), cells: cells[3] ?? '' }
}

const pixelSource = (frame: Extract<Frame, { kind: 'pixels' }>) =>
  ({ file: frame.path, format: 'rgb', width: frame.width, height: frame.height, generation: frame.generation }) as const

/** Writes a line to the keys file the game reads every tick. */
async function sendLine($: EngineInterface, current: Game, text: string) {
  if (current.keysPath === '') return
  current.lineCount += 1
  current.lines = [...current.lines, `${current.lineCount} ${text}`].slice(-32)
  await $.fs.write(current.keysPath, `${current.lines.join('\n')}\n`)
}

/** How long the Image has to be in the pane before a refusal means the terminal cannot draw it. */
const IMAGE_SETTLE_MS = 1500

/** Pictures this terminal cannot show: back to cells, for good. */
async function fallBackToCells($: EngineInterface, current: Game, reason: string) {
  if (current.mode === 'cells') return
  current.mode = 'cells'
  current.note = `hücre modu: terminal resmi göstermedi (${reason})`
  current.frame = undefined
  await sendLine($, current, 'mode cells')
  $.ui.invalidate('ui.render')
}

/** Shows the newest frame: blitted in place, or redrawn when it needs another element. */
async function pump($: EngineInterface, current: Game) {
  if (isBlitting) return
  isBlitting = true
  try {
    while (pending !== undefined) {
      const frame = pending
      pending = undefined
      if (frame.kind === 'pixels') {
        if (current.mode !== 'pixels') continue
        const shown: { deny?: unknown } = await $.ui
          .blit({ requestId: PANE, key: 'screen', source: pixelSource(frame) })
          .catch(err => ({ deny: String(err) }))
        const isSettled = current.imageSince !== undefined && Date.now() - current.imageSince > IMAGE_SETTLE_MS
        if (shown.deny !== undefined && isSettled) await fallBackToCells($, current, String(shown.deny))
        continue
      }
      if (!isSameSize(current.mounted, frame)) {
        $.ui.invalidate('ui.render')
        continue
      }
      await $.ui.blit({ requestId: PANE, key: 'screen', cells: frame.cells }).catch(() => undefined)
    }
  } finally {
    isBlitting = false
  }
}

/** Which build of the game runs here, by operating system and processor. */
async function binaryFor($: EngineInterface): Promise<string | undefined> {
  if ((await $.env.get('OS')) === 'Windows_NT') return 'windows-x64/doom-claude.exe'
  const { stdout } = await $.process.run(['uname', '-sm']).catch(() => ({ stdout: '' }))
  const [system, machine] = stdout.trim().split(/\s+/)
  if (system === 'Darwin') return machine === 'arm64' ? 'macos-arm64/doom-claude' : 'macos-x64/doom-claude'
  if (system === 'Linux' && machine === 'x86_64') return 'linux-x64/doom-claude'
  return undefined
}

/**
 * Whether to try an Image's pixels first: DOOM_MODE says, else kitty, Ghostty
 * and WezTerm are tried. A terminal that refuses the picture falls back to cells.
 */
async function drawsPixels($: EngineInterface): Promise<{ isPixels: boolean; note: string }> {
  const forced = await $.env.get('DOOM_MODE')
  if (forced === 'pixels' || forced === 'cells') return { isPixels: forced === 'pixels', note: `DOOM_MODE=${forced}` }
  const kitty = await $.env.get('KITTY_WINDOW_ID')
  const program = (await $.env.get('TERM_PROGRAM')) ?? ''
  const term = (await $.env.get('TERM')) ?? ''
  const seen = `TERM_PROGRAM=${program || '-'}, TERM=${term || '-'}${kitty === undefined ? '' : ', kitty'}`
  const isPixels = kitty !== undefined || /ghostty|wezterm/i.test(program) || /kitty|ghostty|wezterm/.test(term)
  return { isPixels, note: isPixels ? `piksel modu (${seen})` : `hücre modu: piksel terminali görülmedi (${seen})` }
}

const FREEDOOM_URL = 'https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0.zip'
const NO_WAD =
  'Oyun verisi (WAD) bulunamadı. /doom download ile Freedoom\'u indir (24 MB), ya da DOOM_WAD ortam değişkeniyle kendi WAD dosyanı göster.'

/** Where /doom download puts Freedoom: ~/.claude/doom. */
async function downloadDir($: EngineInterface) {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.'
  return `${home.replace(/[\\/]+$/, '')}/.claude/doom`
}

/** The game data: DOOM_WAD, the mod's own wad/, or what /doom download fetched. */
async function findWad($: EngineInterface): Promise<string | undefined> {
  const chosen = await $.env.get('DOOM_WAD')
  const dir = await downloadDir($)
  const candidates = [
    ...(chosen === undefined ? [] : [chosen]),
    `${$.plugin.root}/wad/freedoom1.wad`,
    `${dir}/freedoom1.wad`,
    `${dir}/freedoom-0.13.0/freedoom1.wad`,
  ]
  for (const path of candidates) if (await $.fs.exists(path)) return path
  return undefined
}

/** Fetches Freedoom into ~/.claude/doom with curl, and unpacks it with tar (or unzip). */
async function downloadFreedoom($: EngineInterface): Promise<string> {
  if ((await findWad($)) !== undefined) return 'Oyun verisi zaten var. /doom ile başlat.'
  const dir = await downloadDir($)
  const zip = `${dir}/freedoom.zip`
  const fetched = await $.process
    .run(['curl', '-fsSL', '--create-dirs', '-o', zip, FREEDOOM_URL], { timeoutMs: 600_000 })
    .catch(err => ({ exitCode: -1, stdout: '', stderr: String(err) }))
  if (fetched.exitCode !== 0) return `İndirilemedi: ${fetched.stderr.trim() || `curl ${fetched.exitCode} ile çıktı`}`
  const untar = await $.process.run(['tar', '-xf', zip, '-C', dir], { timeoutMs: 120_000 }).catch(() => ({ exitCode: -1 }))
  if (untar.exitCode !== 0) {
    const unzip = await $.process.run(['unzip', '-o', zip, '-d', dir], { timeoutMs: 120_000 }).catch(() => ({ exitCode: -1 }))
    if (unzip.exitCode !== 0) return `İndirildi ama açılamadı (tar ve unzip olmadı): ${zip}`
  }
  const wad = await findWad($)
  return wad === undefined ? `Açıldı ama freedoom1.wad bulunamadı: ${dir}` : `Freedoom hazır: ${wad}\n/doom ile başlat.`
}

/** Runs the game for its life: each stdout line is a frame. */
async function run($: EngineInterface, started: Game) {
  const binary = await binaryFor($)
  const wad = await findWad($)
  if (binary === undefined || wad === undefined) {
    started.error = binary === undefined ? 'Bu işletim sistemi için DOOM derlemesi yok (Windows x64, Linux x64 ve macOS var).' : NO_WAD
    started.isStopped = true
    $.ui.invalidate('ui.render')
    return
  }
  const temp = (await $.env.get('TEMP')) ?? (await $.env.get('TMPDIR')) ?? '/tmp'
  const dir = temp.replace(/[\\/]+$/, '')
  started.keysPath = `${dir}/claude-doom-keys.txt`
  await $.fs.write(started.keysPath, '')
  const root = $.plugin.root
  const child = $.process.spawn({
    argv: [
      `${root}/bin/${binary}`,
      '-cols', String(started.wanted.columns),
      '-rows', String(started.wanted.rows),
      '-fps', '30',
      '-keys', started.keysPath,
      '-frames', `${dir}/claude-doom-frame-`,
      '-mode', started.mode,
      '-iwad', wad,
      // straight into the first level, past the title demos (where any key only opens the menu)
      '-skill', '3',
      '-warp', '1', '1',
    ],
  })
  let buffer = ''
  let stderr = ''
  try {
    for await (const piece of child) {
      if (started.isStopped) break
      if (piece.stream === 'stderr') {
        stderr = (stderr + piece.text).slice(-2000)
        continue
      }
      buffer += piece.text
      const end = buffer.lastIndexOf('\n')
      if (end < 0) continue
      const lines = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      const frame = parseFrame(lines.slice(lines.lastIndexOf('\n') + 1))
      if (frame === undefined || (frame.kind === 'pixels') !== (started.mode === 'pixels')) continue
      const isFirst = started.frame === undefined
      started.frame = frame
      if (isFirst) {
        $.ui.invalidate('ui.render')
        continue
      }
      pending = frame
      void pump($, started)
    }
  } catch (err) {
    started.error = `DOOM başlatılamadı: ${String(err)}`
  }
  if (!started.isStopped && started.error === undefined) {
    const tail = stderr.trim().split('\n').slice(-3).join('\n')
    started.error = tail === '' ? 'DOOM kapandı.' : `DOOM kapandı:\n${tail}`
  }
  started.isStopped = true
  $.ui.invalidate('ui.render')
}

/** Passes new presses to the game. */
async function sendKeys($: EngineInterface, keys: { seq: number; key: string }[]) {
  const current = game
  if (current === undefined || current.isStopped) return
  for (const k of keys) {
    if (k.seq <= current.lastKeySeq) continue
    current.lastKeySeq = k.seq
    await sendLine($, current, k.key)
  }
}

async function start($: EngineInterface, size: Size) {
  const started: Game = { mode: 'cells', note: '', wanted: size, isStopped: false, lines: [], lineCount: 0, lastKeySeq: 0, keysPath: '' }
  game = started
  const detected = await drawsPixels($)
  started.note = detected.note
  if (detected.isPixels) started.mode = 'pixels'
  await run($, started)
}

function stop() {
  if (game !== undefined) game.isStopped = true
  game = undefined
  pending = undefined
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'doom',
      description: 'Play DOOM in the side pane: /doom [stop | download]',
      argumentHint: '[stop | download]',
    })
    return next(e)
  })

  on('command.run', { command: 'doom' }, async ($, e) => {
    if (e.args.trim() === 'download') return { text: await downloadFreedoom($) }
    if (e.args.trim() === 'stop') {
      stop()
      $.ui.invalidate('ui.render')
      return { text: 'DOOM durduruldu.' }
    }
    const opened = await $.ui.open({ id: PANE, title: 'DOOM', columns: MAX_CELL_COLUMNS + 2 }).catch(() => undefined)
    if (opened === undefined) return { text: 'DOOM paneli açılamadı.' }
    return {
      text: opened.isPlaced
        ? 'DOOM yan panelde. Klavyeyi vermek için oyunun altındaki satıra tıkla.'
        : 'DOOM paneli açıldı ama sığmadı; terminali genişlet.',
    }
  })

  on('ui.message', async ($, e) => {
    if (e.requestId !== PANE) return {}
    const data = e.data as { keys?: { seq: number; key: string }[] } | null
    if (data !== null && Array.isArray(data.keys)) await sendKeys($, data.keys)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text } = table
    if (e.surface !== 'terminal') return <Text dimColor>DOOM yalnızca terminalde oynanır.</Text>

    const { bodyColumns } = e.props
    const bodyRows = e.props.scroll.bodyRows
    const cellSize = sizeFor(bodyColumns, bodyRows, MAX_CELL_COLUMNS)
    if (game === undefined) {
      void start($, cellSize)
    } else if (!game.isStopped && game.mode === 'cells' && !isSameSize(game.wanted, cellSize)) {
      game.wanted = cellSize
      void sendLine($, game, `size ${cellSize.columns} ${cellSize.rows}`).catch(() => undefined)
    }
    const current = game
    if (current?.error !== undefined) {
      return (
        <Box flexDirection="column">
          <Text color="error">{current.error}</Text>
          <Text dimColor>Yeniden başlatmak için: /doom stop, sonra /doom</Text>
        </Box>
      )
    }
    const frame = current?.frame
    if (current === undefined || frame === undefined) return <Text dimColor>DOOM yükleniyor…</Text>

    const { Raster, Image, Client } = $.ui.resolve(e)
    let screen
    if (frame.kind === 'pixels') {
      const size = sizeFor(bodyColumns, bodyRows, MAX_IMAGE_COLUMNS)
      current.imageSince ??= Date.now()
      screen = <Image key="screen" source={pixelSource(frame)} columns={size.columns} rows={size.rows} alt="DOOM" />
    } else {
      current.mounted = { columns: frame.columns, rows: frame.rows }
      screen = <Raster key="screen" columns={frame.columns} rows={frame.rows} cells={frame.cells} />
    }
    return (
      <Box flexDirection="column">
        {screen}
        <Client key="keys" module="./keys.tsx" props={null} />
        <Text dimColor>{current.note}</Text>
      </Box>
    )
  })
}
