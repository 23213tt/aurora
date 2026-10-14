/*
 * Clicks Netease's sign-in control after waiting for it to exist, and reports whether
 * the QR request actually leaves the renderer.
 *
 * Two earlier attempts failed for reasons that were about the harness, not the app:
 * one searched the whole rail for the text "登录" and matched nothing, the other
 * looked for the control before the platform screen had finished loading its status
 * (Netease's screen waits on a backend call that QQ's does not). Both produced
 * "found: false" while a screenshot showed the button plainly there.
 *
 * So this waits for the control, records the click, and then watches the main-process
 * log for `netease:qrCreate` - the one signal that says the request left the renderer
 * at all.
 *
 * Usage: node scripts/drive-netease-login.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { Cdp, listTargets, sleep, waitForDevtools } from './perf-lib.mjs'

const port = 9226
const exe = path.resolve('release', 'win-unpacked', 'Aurora.exe')
const outDir = path.resolve('.driver')
fs.mkdirSync(outDir, { recursive: true })
const appLog = path.join(process.env.APPDATA ?? '', 'aurora-player', 'startup.log')
try {
  fs.rmSync(appLog, { force: true })
} catch {
  // fine
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(exe, [`--remote-debugging-port=${port}`], { env, stdio: 'ignore' })

const logLines = () => {
  try {
    return fs.readFileSync(appLog, 'utf8').split(/\r?\n/).filter((l) => /netease:qr|qq:qr|FAILED/.test(l))
  } catch {
    return []
  }
}
const snap = async (cdp, name) => {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const file = path.join(outDir, `${name}.png`)
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
  return file
}

let cdp = null
try {
  await waitForDevtools(port, { timeoutMs: 40000 })
  const page = (await listTargets(port)).find((t) => t.type === 'page')
  cdp = await Cdp.connect(page.webSocketDebuggerUrl, { callTimeoutMs: 30000 })
  await cdp.send('Runtime.enable')
  for (let i = 0; i < 40; i += 1) {
    if (await cdp.eval(`Boolean(document.querySelector('.rail'))`)) break
    await sleep(500)
  }

  // Go to the Netease screen.
  await cdp.eval(`(() => {
    const groups = [...document.querySelectorAll('.rail__group')]
    const g = groups.find((x) => (x.querySelector('.rail__heading')?.textContent || '').trim() === '网易云音乐')
    const b = g && [...g.querySelectorAll('button')].find((el) => (el.textContent || '').trim() === '网易云')
    if (b) b.click()
    return Boolean(b)
  })()`)

  /*
   * Wait for the control rather than assuming a delay. Netease's screen asks the main
   * process for status before it draws the account strip, and that round trip is what
   * the earlier attempts raced.
   */
  let label = null
  for (let i = 0; i < 40; i += 1) {
    await sleep(500)
    const probe = await cdp.eval(`(() => {
      const els = [...document.querySelectorAll('button, a')]
      const t = els.find((el) => /登录/.test(el.textContent || '') && !/退出/.test(el.textContent || ''))
      return t ? (t.textContent || '').trim() : ''
    })()`)
    if (probe) {
      label = probe
      break
    }
  }
  console.log(`  等到登录控件: ${JSON.stringify(label)}`)
  console.log(`  点击前日志: ${JSON.stringify(logLines())}`)
  await snap(cdp, 'netease-before-click')

  const clicked = await cdp.eval(`(() => {
    const els = [...document.querySelectorAll('button, a')]
    const t = els.find((el) => /登录/.test(el.textContent || '') && !/退出/.test(el.textContent || ''))
    if (!t) return false
    t.click()
    return true
  })()`)
  console.log(`  已点击: ${clicked}`)

  for (let i = 1; i <= 8; i += 1) {
    await sleep(1500)
    const state = await cdp.eval(`(() => {
      const d = [...document.querySelectorAll('[role="dialog"]')]
      const imgs = [...document.querySelectorAll('img')].map((x) => (x.getAttribute('src') || '').slice(0, 34) + ' ' + x.naturalWidth + 'x' + x.naturalHeight)
      return JSON.stringify({ dialogs: d.length, text: d.map((x) => (x.textContent || '').replace(/\\s+/g, ' ').slice(0, 160)), imgs })
    })()`)
    console.log(`  第 ${i} 次: ${state}`)
    console.log(`   日志: ${JSON.stringify(logLines())}`)
    const parsed = JSON.parse(state)
    if (parsed.dialogs > 0 && (parsed.imgs.length > 0 || parsed.text.some((t) => t.length > 10))) break
  }
  console.log(`  截图: ${await snap(cdp, 'netease-after-click')}`)
} catch (error) {
  console.log(`  失败: ${error.message}`)
} finally {
  if (cdp) cdp.close()
  try {
    child.kill()
  } catch {
    // ignore
  }
  await sleep(1000)
  process.exit(0)
}
