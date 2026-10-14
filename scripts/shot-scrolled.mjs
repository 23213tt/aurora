/*
 * Screenshot one scrolled state of a preview screen.
 *
 * The preview screens scroll their content internally, so a viewport capture only
 * ever shows the top. This drives an already-running headless browser over CDP,
 * scrolls the named element, and writes a PNG - which is how the lower half of a
 * long settings page gets reviewed at all.
 *
 * Usage: node scripts/shot-scrolled.mjs <file.html> <out.png> [scrollTop] [selector]
 */
import fs from 'node:fs'
import path from 'node:path'

const [file, out, scrollArg, selector = '.main__body'] = process.argv.slice(2)
if (!file || !out) {
  console.error('usage: node scripts/shot-scrolled.mjs <file.html> <out.png> [scrollTop] [selector]')
  process.exit(1)
}
const scrollTop = Number(scrollArg ?? 100000)

const endpoint = await (async () => {
  const response = await fetch('http://127.0.0.1:9222/json/list')
  const targets = await response.json()
  const page = targets.find((target) => target.type === 'page')
  if (!page?.webSocketDebuggerUrl) throw new Error('no page target on :9222')
  return page.webSocketDebuggerUrl
})()

const ws = new WebSocket(endpoint)
let nextId = 1
const pending = new Map()

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })

ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(JSON.stringify(message.error)))
    else resolve(message.result)
  }
})

await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))

const url = 'file:///' + path.resolve(file).replace(/\\/g, '/')
await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url })
await new Promise((resolve) => setTimeout(resolve, 2500))

const scrolled = await send('Runtime.evaluate', {
  expression: `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'missing';
    el.scrollTop = ${scrollTop};
    return el.scrollTop + '/' + el.scrollHeight;
  })()`,
  returnByValue: true
})
console.log('scroll:', scrolled.result?.value)

await new Promise((resolve) => setTimeout(resolve, 350))
const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
console.log('wrote', out)
ws.close()
