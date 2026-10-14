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

/**
 * Appends one line, synchronously.
 *
 * Not a `WriteStream`: that buffers, and the first version of this file proved the
 * point by leaving a zero-byte `startup.log` behind after a run that never flushed.
 * The whole purpose here is to survive a crash, so each line has to be on disk by
 * the time the call returns - the cost of a synchronous append on a handful of lines
 * is nothing next to losing the only evidence.
 */
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
