/**
 * End-to-end check of the packed plugin in a real OpenCode, against the mock
 * gateway. Run with `bun run test:opencode`.
 *
 * OPENCODE_VERSION picks the release: an exact version such as 2.2.7, or
 * "latest" for the newest 2.x release. It defaults to `opencode.tested` in
 * package.json. OPENCODE_BIN uses an existing binary instead of downloading.
 *
 * OpenCode runs with an empty home directory and a minimal environment, so no
 * credential or config from the machine running the test is visible to it.
 */
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { newestDeepSeekFlash, toModels } from "../src/catalog.js"
import { REPLY, startMockGateway } from "./mock-gateway.js"

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
const catalog = JSON.parse(readFileSync(join(ROOT, "test/fixtures/models.json"), "utf8"))
const work = mkdtempSync(join(tmpdir(), "cail-opencode-smoke-"))
const step = (message: string) => console.log(`• ${message}`)

function run(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 180_000, ...options })
  if (result.error) throw result.error
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** Like run, but leaves this process free to serve the mock gateway while OpenCode calls it. */
function runAsync(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    const timer = setTimeout(() => child.kill(), 180_000)
    child.on("error", reject)
    child.on("close", (status) => {
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    })
  })
}

async function releaseVersion() {
  const wanted = process.env.OPENCODE_VERSION ?? pkg.opencode.tested
  if (wanted !== "latest") return wanted.replace(/^v/, "")
  // GitHub's "latest" release badge still points at OpenCode 1.x, so pick the highest 2.x release.
  const headers: Record<string, string> = { accept: "application/vnd.github+json" }
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const releases = (await (
    await fetch("https://api.github.com/repos/anomalyco/opencode/releases?per_page=50", { headers })
  ).json()) as { tag_name: string; draft: boolean; prerelease: boolean }[]
  const versions = releases
    .filter((release) => !release.draft && !release.prerelease && /^v2\.\d+\.\d+$/.test(release.tag_name))
    .map((release) => release.tag_name.slice(1).split(".").map(Number))
    .sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!)
  const newest = versions.at(-1)
  assert.ok(newest, "no OpenCode 2.x release found")
  return newest.join(".")
}

function assetName() {
  const arch = process.arch === "arm64" ? "arm64" : "x64"
  if (process.platform === "darwin") return `opencode-darwin-${arch}.zip`
  if (process.platform === "win32") return `opencode-windows-${arch}.zip`
  return `opencode-linux-${arch}.tar.gz`
}

function findBinary(dir: string): string | undefined {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      const found = findBinary(path)
      if (found) return found
    } else if (entry === "opencode" || entry === "opencode.exe") return path
  }
  return undefined
}

async function openCodeBinary() {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN
  const version = await releaseVersion()
  const asset = assetName()
  const base = `https://github.com/anomalyco/opencode/releases/download/v${version}`
  step(`downloading OpenCode ${version} (${asset})`)
  const archive = Buffer.from(await (await fetch(`${base}/${asset}`)).arrayBuffer())
  const sums = await (await fetch(`${base}/SHA256SUMS`)).text()
  const expected = sums.split("\n").find((line) => line.trim().endsWith(asset))?.split(/\s+/)[0]
  assert.equal(createHash("sha256").update(archive).digest("hex"), expected, `checksum mismatch for ${asset}`)
  const dir = join(work, "opencode")
  mkdirSync(dir)
  writeFileSync(join(dir, asset), archive)
  const unpacked = run("tar", ["-xf", asset], { cwd: dir })
  assert.equal(unpacked.status, 0, unpacked.stderr)
  const binary = findBinary(dir)
  assert.ok(binary, "no opencode binary in the release archive")
  if (process.platform !== "win32") run("chmod", ["+x", binary])
  return binary
}

/** The package as npm would publish it, unpacked outside the checkout. */
function packedPlugin() {
  const packed = run(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", "--pack-destination", work], {
    cwd: ROOT,
    ...(process.platform === "win32" ? { shell: true } : {}),
  } as never)
  assert.equal(packed.status, 0, packed.stderr)
  const tarball = readdirSync(work).find((entry) => entry.endsWith(".tgz"))
  assert.ok(tarball)
  const unpacked = run("tar", ["-xzf", tarball], { cwd: work })
  assert.equal(unpacked.status, 0, unpacked.stderr)
  const dir = join(work, "package")
  assert.ok(existsSync(join(dir, "dist/index.js")), "the package is missing dist/index.js")
  assert.ok(!existsSync(join(dir, "node_modules")), "the package should have no dependencies")
  return dir
}

/** Windows can hold OpenCode's files for a moment after its service stops; leftover temp files don't fail the test. */
function removeTemp(path: string) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
  } catch (error) {
    console.warn(`Could not remove ${path}: ${(error as Error).message}`)
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  const binary = await openCodeBinary()
  const plugin = packedPlugin()
  const mock = await startMockGateway()
  const home = join(work, "home")
  const project = join(home, "project")
  mkdirSync(join(home, ".config/opencode"), { recursive: true })
  mkdirSync(project, { recursive: true })

  const config = (extra: Record<string, unknown> = {}) =>
    writeFileSync(
      join(home, ".config/opencode/opencode.jsonc"),
      JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          plugins: [{ package: plugin, options: { origin: mock.origin, hostname: "test-laptop" } }],
          ...extra,
        },
        null,
        2,
      ),
    )
  config()

  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    TERM: "dumb",
    ...(process.platform === "win32"
      ? {
          SystemRoot: process.env.SystemRoot,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          APPDATA: join(home, "AppData/Roaming"),
          LOCALAPPDATA: join(home, "AppData/Local"),
        }
      : {}),
  }
  const opencode = (...args: string[]) => runAsync(binary, args, { env, cwd: project })
  const api = async (operation: string, params: Record<string, string>, data?: unknown) => {
    const args = ["api", operation, ...Object.entries(params).flatMap(([key, value]) => ["--param", `${key}=${value}`])]
    if (data !== undefined) args.push("-d", JSON.stringify(data))
    const result = await opencode(...args)
    try {
      return { status: result.status, body: JSON.parse(result.stdout) }
    } catch {
      return { status: result.status, body: undefined, raw: `${result.stdout}${result.stderr}` }
    }
  }
  const integration = async () => (await api("integration.get", { integrationID: "cail" })).body?.data
  let failed = false

  try {
    console.log(`OpenCode ${(await opencode("--version")).stdout.trim()}`)

    step("the plugin adds CUNY AI Lab with its sign-in methods")
    let found
    for (let attempt = 0; attempt < 30 && !found; attempt++) {
      found = await integration()
      if (!found) await sleep(1000)
    }
    assert.ok(found, "OpenCode did not load the CUNY AI Lab integration")
    assert.equal(found.name, "CUNY AI Lab")
    assert.deepEqual(
      found.methods.map((method: { id?: string; type: string }) => method.id ?? method.type),
      ["browser", "code", "key", "env"],
    )

    step("signing in with a code connects the integration")
    const attempt = (await api("integration.oauth.connect", { integrationID: "cail" }, { methodID: "code" })).body.data
    const link = new URL(attempt.url)
    assert.equal(`${link.origin}${link.pathname}`, `${mock.origin}/model-access/connect`)
    assert.equal(link.searchParams.get("client"), "opencode")
    assert.equal(link.searchParams.get("device"), "test-laptop")
    const code = mock.issueCode(link.searchParams.get("code_challenge")!)
    const completed = await api(
      "integration.oauth.complete",
      { integrationID: "cail", attemptID: attempt.attemptID },
      { code },
    )
    assert.equal(completed.status, 0, JSON.stringify(completed))
    const connections = (await integration()).connections
    assert.equal(connections.length, 1)
    assert.match(connections[0].label, /^OpenCode on test-laptop, signed in \d{4}-\d{2}-\d{2}$/)

    step("the gateway's tool-capable models are listed and DeepSeek Flash is the default")
    const expected = toModels(catalog)
    const listed = (await opencode("models"))
      .stdout.split(/\r?\n/)
      .filter((line) => line.startsWith("cail/"))
    assert.equal(listed.length, expected.length)
    const flash = newestDeepSeekFlash(expected)!.id
    assert.equal((await api("model.default", {})).body.data.id, flash)

    step("a prompt reaches the gateway with the signed-in key")
    const reply = await opencode("run", "-m", `cail/${flash}`, "--archived", "Say pong")
    assert.match(reply.stdout, new RegExp(REPLY), `${reply.stdout}\n${reply.stderr}`)
    assert.equal(mock.chatRequests.at(-1)?.authorization, `Bearer ${mock.keys[0]}`)

    step("signing in again in the browser replaces the first key")
    const browser = (await api("integration.oauth.connect", { integrationID: "cail" }, { methodID: "browser" })).body.data
    assert.equal(browser.mode, "auto")
    const browserLink = new URL(browser.url)
    const redirect = browserLink.searchParams.get("redirect_uri")!
    const state = browserLink.searchParams.get("state")!
    assert.equal((await fetch(`${redirect}?code=x&state=wrong`)).status, 404)
    const page = await fetch(
      `${redirect}?code=${mock.issueCode(browserLink.searchParams.get("code_challenge")!)}&state=${state}`,
    )
    assert.match(await page.text(), /OpenCode is connected/)
    let status
    for (let tries = 0; tries < 20 && status !== "complete"; tries++) {
      status = (await api("integration.oauth.status", { integrationID: "cail", attemptID: browser.attemptID })).body?.data?.status
      if (status !== "complete") await sleep(500)
    }
    assert.equal(status, "complete")
    assert.ok(mock.tokenRequests.at(-1)?.replace_key_id, "the second sign-in did not name the first key")
    assert.equal(mock.keys.length, 1, "the mock should have revoked the first key")
    const accounts = (await integration()).connections
    assert.equal(accounts.length, 2)
    assert.ok(
      accounts.some((account: { status?: { status: string } }) => account.status?.status === "needs_auth"),
      "the replaced account was not marked",
    )
    const again = await opencode("run", "-m", `cail/${flash}`, "--archived", "Say pong")
    assert.match(again.stdout, new RegExp(REPLY), `${again.stdout}\n${again.stderr}`)
    assert.equal(mock.chatRequests.at(-1)?.authorization, `Bearer ${mock.keys[0]}`)

    step("a default model in the config wins")
    const other = expected.find((model) => model.id !== flash)!.id
    config({ model: `cail/${other}` })
    await opencode("reload")
    let chosen
    for (let tries = 0; tries < 20 && chosen !== other; tries++) {
      chosen = (await api("model.default", {})).body?.data?.id
      if (chosen !== other) await sleep(500)
    }
    assert.equal(chosen, other)

    console.log("OpenCode smoke test passed")
  } catch (error) {
    const log = join(home, ".local/share/opencode/log/opencode.log")
    if (existsSync(log)) {
      const lines = readFileSync(log, "utf8").split("\n").filter((line) => /level=(ERROR|WARN)|oauth|credential|cause|defect|fail/i.test(line))
      console.error(`OpenCode errors and warnings:\n${lines.slice(-15).join("\n")}`)
    }
    failed = true
    throw error
  } finally {
    await opencode("service", "stop")
    await mock.close()
    if (failed && process.env.KEEP_FAILED) console.error(`Kept ${work}`)
    else removeTemp(work)
  }
}

await main()
