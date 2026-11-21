import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'

// Stamp the page with the commit it was built from, so the deployed commit can
// be read back with `curl -s https://loop.ltlian.com | grep git-commit`.
const commitHash = readCommitHash()

function readCommitHash() {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
  } catch {
    return process.env.GITHUB_SHA?.slice(0, 7) ?? 'unknown'
  }
}

export default defineConfig({
  server: { host: '127.0.0.1', port: 5180, strictPort: true },
  plugins: [
    {
      name: 'inject-build-constants',
      transformIndexHtml: (html) => html.replace('__COMMIT_HASH__', commitHash),
    },
  ],
})
