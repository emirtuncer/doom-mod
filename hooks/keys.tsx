import type { ClientKeyEvent, ClientModule } from 'claude-code'

type Pressed = { seq: number; key: string }
type State = { keys: Pressed[]; seq: number; last?: string }

/** A key as one word the game reads: names as they come, a space as "space". */
const nameOf = (event: ClientKeyEvent) => (event.key === ' ' ? 'space' : event.key.toLowerCase())

/** The keyboard: holds the focus while you play and posts each press to the hooks. */
const Keys: ClientModule<null, State> = (_props, surface) => {
  const { Box, Text } = surface.elements
  const state = surface.state
  if (state === undefined) {
    let current: State = { keys: [], seq: 0 }
    surface.onKey(event => {
      if (event.ctrl === true || event.meta === true) return
      const key = nameOf(event)
      if (!/^[a-z0-9]+$/.test(key)) return
      const seq = current.seq + 1
      current = { keys: [...current.keys, { seq, key }].slice(-24), seq, last: key }
      surface.post({ keys: current.keys })
      surface.setState(current)
    })
  }
  const isPlaying = state?.last !== undefined

  return (
    <Box flexDirection="column">
      <Text bold color={isPlaying ? 'success' : 'warning'}>
        {isPlaying ? `🎮 Oynanıyor · son tuş: ${state?.last}` : '▶ Oynamak için buraya tıkla'}
      </Text>
      <Text dimColor>
        W/S/A/D veya oklar: hareket · Q/E: yana kay · boşluk/F: ateş · R: kapı aç · 1-7: silah · Tab: harita · P: menü · Enter: seç · Esc: odaktan çık
      </Text>
    </Box>
  )
}

export default Keys
