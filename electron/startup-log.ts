/** 启动日志。渲染层没跑起来时，这是唯一能留下线索的地方。 */
import fs from 'node:fs'
import path from 'node:path'

let logPath: string | null = null
let usable = false

/** Where the log lives, for the "it is broken, send me this" message. */
export function startupLogPath(): string | null {
  return logPath
}

export function openStartupLog(logDir: string, appVersion: string, packaged: boolean): void {
  try {
    fs.mkdirSync(logDir, { recursive: true })
    logPath = path.join(logDir, 'startup.log')
    // Truncate each run: this is about the run that failed, not history.
    fs.writeFileSync(logPath, '', 'utf-8')
    usable = true
    write('aurora startup log')
    write(`version=${appVersion} packaged=${packaged}`)
    write(`node=${process.versions.node} electron=${process.versions.electron} chrome=${process.versions.chrome}`)
    write(`resourcesPath=${process.resourcesPath}`)
    write(`platform=${process.platform} arch=${process.arch}`)
  } catch {
    // A log that cannot be written must not stop the app from starting.
    usable = false
  }
}

/** 同步追加。用 WriteStream 会缓冲，进程被强杀时日志是空的（踩过一次）。 */
export function write(line: string): void {
  if (!usable || !logPath) return
  try {
    fs.appendFileSync(logPath, `${new Date().toISOString()}  ${line}\n`, 'utf-8')
  } catch {
    // ignore
  }
}

export function closeStartupLog(): void {
  // Nothing to flush: every line is already on disk. Kept for the call sites that
  // expect a symmetry with `openStartupLog`.
  usable = false
}
