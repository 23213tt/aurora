import assert from 'node:assert/strict'
import { test } from 'node:test'
import { repositoryTarget } from '../electron/release-target.ts'

/**
 * "Which repository does this build check for updates?" was answered wrongly for
 * every shipped version, so these cases are written against the packaged file
 * rather than the source one.
 *
 * The packaged `package.json` inside app.asar has exactly these keys:
 *   name, private, version, description, author, license, repository, main, dependencies
 * — `build` is stripped by electron-builder. Reading `build.publish` therefore
 * always failed in a real install while looking right in development.
 */

test('the packaged package.json yields a target from repository.url', () => {
  // Copied verbatim from the app.asar of the 0.3.0 build.
  const packaged = {
    name: 'aurora-player',
    private: true,
    version: '0.3.0',
    description: 'x',
    author: 'Aurora contributors',
    license: 'MIT',
    repository: { type: 'git', url: 'https://github.com/23213tt/aurora.git' },
    main: 'dist-electron/main.js',
    dependencies: {}
  }
  assert.deepEqual(repositoryTarget(packaged), { owner: '23213tt', repo: 'aurora' })
})

test('the source package.json still works through build.publish', () => {
  const source = { build: { publish: { provider: 'github', owner: 'someone', repo: 'thing' } } }
  assert.deepEqual(repositoryTarget(source), { owner: 'someone', repo: 'thing' })
})

test('repository.url wins when the publish block is absent', () => {
  assert.deepEqual(repositoryTarget({ repository: 'https://github.com/o/r' }), { owner: 'o', repo: 'r' })
})

test('the forms a repository url actually takes', () => {
  const cases: [string, { owner: string; repo: string }][] = [
    ['https://github.com/o/r.git', { owner: 'o', repo: 'r' }],
    ['https://github.com/o/r', { owner: 'o', repo: 'r' }],
    ['git+https://github.com/o/r.git', { owner: 'o', repo: 'r' }],
    ['git@github.com:o/r.git', { owner: 'o', repo: 'r' }],
    ['https://github.com/o/r/', { owner: 'o', repo: 'r' }]
  ]
  for (const [url, expected] of cases) {
    assert.deepEqual(repositoryTarget({ repository: { url } }), expected, url)
  }
})

test('a placeholder config is reported as unconfigured, not guessed at', () => {
  const fresh = { build: { publish: { owner: 'REPLACE-WITH-YOUR-USERNAME', repo: 'REPLACE-WITH-YOUR-REPO' } } }
  assert.equal(repositoryTarget(fresh), null)
})

test('a non-GitHub or missing repository is null rather than a wrong target', () => {
  assert.equal(repositoryTarget({}), null)
  assert.equal(repositoryTarget({ repository: 'https://gitlab.com/o/r' }), null)
  assert.equal(repositoryTarget({ repository: { url: '' } }), null)
})
