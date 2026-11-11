/**
 * Optional check against the real CUNY AI Lab gateway:
 *
 *   CAIL_LIVE_KEY=sk-cail-p_... bun run test:live
 *
 * It loads the plugin from this checkout into an OpenCode with an empty home,
 * passes the key through AILAB_API_KEY (so it never appears in OpenCode's
 * command-line log), and asks the newest DeepSeek Flash for a one-word reply.
 * The key is never printed. OPENCODE_BIN, or an `opencode` on PATH, is used.
 */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { newestDeepSeekFlash, toModels } from "../src/catalog.js"

const key = process.env.CAIL_LIVE_KEY
if (!key) {
  console.log("CAIL_LIVE_KEY is not set; skipping the live check")
  process.exit(0)
}
const binary = process.env.OPENCODE_BIN ?? "opencode"
const root = new URL("..", import.meta.url).pathname
const work = mkdtempSync(join(tmpdir(), "cail-opencode-live-"))
const home = join(work, "home")
mkdirSync(join(home, ".config/opencode"), { recursive: true })
mkdirSync(join(home, "project"))
writeFileSync(join(home, ".config/opencode/opencode.jsonc"), JSON.stringify({ plugins: [root] }))

const env = {
  PATH: process.env.PATH,
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local/share"),
  XDG_STATE_HOME: join(home, ".local/state"),
  XDG_CACHE_HOME: join(home, ".cache"),
  TERM: "dumb",
  AILAB_API_KEY: key,
}
/** Windows can hold OpenCode's files for a moment after its service stops; leftover temp files don't fail the test. */
function removeTemp(path: string) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
  } catch (error) {
    console.warn(`Could not remove ${path}: ${(error as Error).message}`)
  }
}

const opencode = (...args: string[]) =>
  new Promise<{ status: number | null; output: string }>((resolve, reject) => {
    const child = spawn(binary, args, { env, cwd: join(home, "project"), stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    child.stdout.on("data", (chunk) => (output += chunk))
    child.stderr.on("data", (chunk) => (output += chunk))
    child.on("error", reject)
    child.on("close", (status) => resolve({ status, output: output.replaceAll(key, "[key]") }))
  })

try {
  const catalog = await (await fetch("https://tools.ailab.gc.cuny.edu/v1/models")).json()
  const expected = toModels(catalog)
  const flash = newestDeepSeekFlash(expected)
  assert.ok(flash, "the live catalog has no DeepSeek Flash")

  let listed: string[] = []
  for (let attempt = 0; attempt < 30 && listed.length < expected.length; attempt++) {
    listed = (await opencode("models")).output.split(/\r?\n/).filter((line) => line.startsWith("cail/"))
    if (listed.length < expected.length) await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  assert.equal(listed.length, expected.length, "OpenCode did not list the live catalog")
  console.log(`• OpenCode lists ${listed.length} CUNY AI Lab models`)

  const reply = await opencode("run", "-m", `cail/${flash.id}`, "--archived", "Reply with the single word: pong")
  assert.equal(reply.status, 0, reply.output)
  assert.match(reply.output, /pong/i, reply.output)
  console.log(`• ${flash.id} answered through the gateway`)
  console.log("Live check passed")
} finally {
  await opencode("service", "stop")
  removeTemp(work)
}
