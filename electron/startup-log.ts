/**
 * A startup log, written next to the app's other user data.
 *
 * Needed because a packaged build opened as a blank window and there was no way to
 * find out why: the renderer never runs in that state, so it cannot report anything,
 * and the only visible trace was a 404 body. This records what the main process
 * actually saw - every renderer request and its outcome, plus anything the renderer
 * itself managed to log before it died.
 *
 * Deliberately a file rather than only a window or the console: a user can send a
 * file, and a window that never renders cannot show anything at all.
 */
import fs from 'node:fs'
import path from 'node:path'

let logPath: string | null = null
let logStream: fs.WriteStream | null = null

/** Where the log lives, for the "it is broken, send me this" message. */
export function startupLogPath(): string | null {
  return logPath
}

export function openStartupLog(appDataDir: string, appVersion: string, packaged: boolean): void {
  try {
    fs.mkdirSync(appDataDir, { recursive: true })
    logPath = path.join(appDataDir, 'startup.log')
    // Truncate each run: this is about the run that failed, not history.
    logStream = fs.createWriteStream(logPath, { flags: 'w' })
    write('aurora startup log')
    write(`version=${appVersion} packaged=${packaged}`)
    write(`node=${process.versions.node} electron=${process.versions.electron} chrome=${process.versions.chrome}`)
    write(`resourcesPath=${process.resourcesPath}`)
    write(`platform=${process.platform} arch=${process.arch}`)
  } catch {
    // A log that cannot be written must not stop the app from starting.
    logStream = null
  }
}

export function write(line: string): void {
  if (!logStream) return
  try {
    logStream.write(`${new Date().toISOString()}  ${line}\n`)
  } catch {
    // ignore
  }
}

export function closeStartupLog(): void {
  try {
    logStream?.end()
  } catch {
    // ignore
  }
  logStream = null
}
