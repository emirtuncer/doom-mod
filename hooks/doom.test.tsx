import { expect, test } from 'claude-code/testing'

test('/doom opens the pane, and the pane says the game is terminal-only on desktop', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const opened = await $.command.run({ command: 'doom', args: '' } as never)
  expect(opened.text).toMatch(/yan panelde/)

  const ui = await $.ui.mount({
    plugin: 'doom',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'doom',
    props: { bodyColumns: 120, scroll: { bodyRows: 40 } } as never,
  })
  expect(await ui.find({ text: /yalnızca terminalde/ })).toBeDefined()
  await ui.unmount()
})

test('/doom stop answers without a game running', async $ => {
  expect((await $.command.run({ command: 'doom', args: 'stop' } as never)).text).toBe('DOOM durduruldu.')
})
