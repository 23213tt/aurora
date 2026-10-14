/*
 * Opens a platform's sign-in dialog and reports what is inside it.
 *
 * Everything before this is known: the app renders, both platforms register, the rail
 * switches views, and the main process answers `qrCreate` with an image. What is left
 * is the dialog itself - whether it appears, whether the image lands in the DOM, and
 * what text a user would be left reading if it does not.
 *
 * Usage: node scripts/drive-qr-dialog.mjs [--platform=qq|netease]
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { Cdp, listTargets, sleep, waitForDevtools } from './perf-lib.mjs'

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=')[1] : fallback
}
const platform = arg('platform', 'qq')
const port = 9225
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

  const label = platform === 'qq' ? 'QQ 音乐' : '网易云音乐'
  // Go to the platform's own screen first; its content is what offers sign-in.
  await cdp.eval(`(() => {
    const groups = [...document.querySelectorAll('.rail__group')]
    const group = groups.find((g) => (g.querySelector('.rail__heading')?.textContent || '').trim() === ${JSON.stringify(label)})
    const b = group && [...group.querySelectorAll('button')].find((el) => (el.textContent || '').trim() === ${JSON.stringify(label)})
    if (b) b.click()
    return Boolean(b)
  })()`)
  await sleep(2500)

  // Then the first control on the page that offers to sign in.
  const clicked = await cdp.eval(`(() => {
    const candidates = [...document.querySelectorAll('button, a')]
    const target = candidates.find((el) => /登录/.test(el.textContent || '') && !/退出/.test(el.textContent || ''))
    if (!target) return JSON.stringify({ found: false, texts: candidates.map((c) => (c.textContent || '').trim()).filter(Boolean).slice(0, 20) })
    target.click()
    return JSON.stringify({ found: true, text: (target.textContent || '').trim() })
  })()`)
  console.log(`  点击登录控件: ${clicked}`)

  // A QR code is fetched over IPC, so give it several seconds, then look at the DOM.
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    await sleep(1500)
    const state = await cdp.eval(`(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"]')]
      const imgs = [...document.querySelectorAll('img')].map((i) => ({ src: (i.getAttribute('src') || '').slice(0, 46), natural: i.naturalWidth + 'x' + i.naturalHeight }))
      const dialogText = dialogs.map((d) => (d.textContent || '').replace(/\\s+/g, ' ').slice(0, 200))
      return JSON.stringify({ dialogs: dialogs.length, dialogText, imgCount: imgs.length, imgs })
    })()`)
    console.log(`  第 ${attempt} 次检查: ${state}`)
    const parsed = JSON.parse(state)
    if (parsed.imgCount > 0 || (parsed.dialogText && parsed.dialogText.some((t) => t.length > 0))) {
      if (parsed.imgCount > 0) break
    }
  }
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(outDir, `qr-${platform}.png`), Buffer.from(shot.data, 'base64'))
  console.log(`  截图: ${path.join(outDir, `qr-${platform}.png`)}`)
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
  console.log('')
  console.log('=== 日志中的登录相关行 ===')
  try {
    for (const line of fs.readFileSync(appLog, 'utf8').split(/\r?\n/)) {
      if (/qr|netease:|qq:|FAILED/i.test(line)) console.log(`  ${line}`)
    }
  } catch {
    console.log('  （没有日志）')
  }
  process.exit(0)
}
