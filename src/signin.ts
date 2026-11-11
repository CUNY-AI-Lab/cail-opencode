/**
 * "Sign in with CUNY AI Lab" for OpenCode.
 *
 * OpenCode opens the Lab's connect page in the browser with a PKCE challenge.
 * After CUNY Login the member approves OpenCode, and the page hands back a
 * one-time code: to a loopback callback on this computer, or, in the code
 * method, as a code to paste. The plugin trades the code and its verifier for
 * a personal key named "OpenCode on <computer>" that expires after 180 days.
 * Signing in again replaces the key from the previous sign-in rather than
 * adding another.
 *
 * Nothing here logs the code, the verifier, or the key.
 */
import { createHash, randomBytes } from "node:crypto"
import { createServer, type Server } from "node:http"
import os from "node:os"

export const CLIENT = "opencode"
export const EXPIRED_MESSAGE = "Your CUNY AI Lab sign-in has expired. Sign in with CUNY AI Lab again."
export const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000

const EXCHANGE_TIMEOUT_MS = 30_000
const CALLBACK_PATH = "/callback"
const SIGN_IN_CODE = /^[A-Za-z0-9_-]{43}$/
const PERSONAL_KEY = /^sk-cail-p_([0-9a-f]{32})_[A-Za-z0-9]{40}$/

const base64Url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url")

export function pkcePair() {
  const verifier = base64Url(randomBytes(32))
  return { verifier, challenge: base64Url(createHash("sha256").update(verifier).digest()) }
}

export function randomState() {
  return base64Url(randomBytes(24))
}

/** The computer's name as the Lab shows it: the hostname, limited to the characters it accepts. */
export function deviceName(hostname = os.hostname()) {
  const name = hostname
    .replace(/\.local$/i, "")
    .replace(/[^A-Za-z0-9._ -]+/g, "-")
    .slice(0, 64)
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "")
  return name || "computer"
}

/** The key id inside a personal key, formatted as the UUID the Lab uses. */
export function keyIdFromKey(key: unknown) {
  const hex = typeof key === "string" ? PERSONAL_KEY.exec(key)?.[1] : undefined
  if (!hex) return undefined
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function isPersonalKey(key: unknown): key is string {
  return typeof key === "string" && PERSONAL_KEY.test(key)
}

export function connectUrl(
  origin: string,
  input: { device: string; challenge: string; redirectUri?: string; state?: string },
) {
  const query = new URLSearchParams({ client: CLIENT, device: input.device, code_challenge: input.challenge })
  if (input.redirectUri && input.state) {
    query.set("redirect_uri", input.redirectUri)
    query.set("state", input.state)
  }
  return `${origin}/model-access/connect?${query}`
}

/** Accept the code itself, or the callback address a browser on another computer could not open. */
export function codeFromInput(input: unknown, state?: string) {
  const value = String(input ?? "").trim()
  if (SIGN_IN_CODE.test(value)) return value
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("That is not a CUNY AI Lab sign-in code. Copy the code from the browser and try again.")
  }
  if (state !== undefined && url.searchParams.get("state") !== state) {
    throw new Error("That address belongs to a different sign-in. Start signing in again.")
  }
  const code = url.searchParams.get("code") ?? ""
  if (!SIGN_IN_CODE.test(code)) {
    throw new Error("That address has no sign-in code. Copy the code from the browser and try again.")
  }
  return code
}

export interface IssuedKey {
  readonly key: string
  readonly expires: number
  readonly keyName: string | undefined
}

function errorMessage(payload: unknown) {
  const body = payload as { message?: unknown; error?: { message?: unknown } } | undefined
  if (typeof body?.message === "string") return body.message
  if (typeof body?.error?.message === "string") return body.error.message
  return undefined
}

export async function exchangeCode(input: {
  code: string
  verifier: string
  replaceKeyId?: string
  origin: string
  fetch?: typeof globalThis.fetch
}): Promise<IssuedKey> {
  const body: Record<string, string> = { code: input.code, code_verifier: input.verifier }
  if (input.replaceKeyId) body.replace_key_id = input.replaceKeyId
  let response: Response
  try {
    response = await (input.fetch ?? globalThis.fetch)(`${input.origin}/model-access/v1/connect/token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    })
  } catch {
    throw new Error("OpenCode could not reach CUNY AI Lab to finish signing in. Check your connection and try again.")
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    payload = undefined
  }
  if (!response.ok) throw new Error(errorMessage(payload) ?? `CUNY AI Lab sign-in failed (HTTP ${response.status}).`)
  const result = payload as { key?: unknown; credential?: { expiresAt?: unknown; label?: unknown } } | undefined
  const expires = result?.credential?.expiresAt
  if (!isPersonalKey(result?.key) || typeof expires !== "number" || !Number.isSafeInteger(expires)) {
    throw new Error("CUNY AI Lab sent an unexpected sign-in response.")
  }
  const label = result.credential?.label
  return { key: result.key, expires, keyName: typeof label === "string" ? label : undefined }
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character,
  )

function page(title: string, message: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;color:#182d40}@media(prefers-color-scheme:dark){body{background:#0c1620;color:#e3ebf3}}</style></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`
}

export interface CallbackServer<T> {
  readonly redirectUri: string
  readonly result: Promise<T>
  close(): void
}

/**
 * One-shot loopback server for the connect page's redirect. It runs the
 * exchange before answering, so the browser shows the real outcome, and it
 * closes itself when the sign-in finishes or times out.
 */
export async function startCallbackServer<T>(input: {
  state: string
  complete: (code: string) => Promise<T>
  timeoutMs?: number
}): Promise<CallbackServer<T>> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const result = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  result.catch(() => {})
  let claimed = false
  let settled = false
  let server: Server | undefined
  const finish = (outcome: { value: T } | { error: Error }) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    server?.close()
    if ("error" in outcome) reject(outcome.error)
    else resolve(outcome.value)
  }
  const timer = setTimeout(
    () => finish({ error: new Error("CUNY AI Lab sign-in timed out. Start signing in again.") }),
    input.timeoutMs ?? SIGN_IN_TIMEOUT_MS,
  )
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    const send = (status: number, title: string, message: string) => {
      response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
      response.end(page(title, message))
    }
    if (request.method !== "GET" || url.pathname !== CALLBACK_PATH || url.searchParams.get("state") !== input.state) {
      send(404, "Not found", "This is OpenCode's CUNY AI Lab sign-in helper. Nothing is waiting at this address.")
      return
    }
    if (claimed || settled) {
      send(409, "Already handled", "OpenCode has already finished this sign-in. You can close this tab.")
      return
    }
    if (url.searchParams.get("error") === "access_denied") {
      send(200, "Sign-in cancelled", "OpenCode was not connected. You can close this tab.")
      finish({ error: new Error("Sign-in cancelled") })
      return
    }
    let code: string
    try {
      code = codeFromInput(url.href, input.state)
    } catch (error) {
      send(400, "Sign-in failed", (error as Error).message)
      return
    }
    claimed = true
    input.complete(code).then(
      (value) => {
        send(200, "OpenCode is connected", "OpenCode is signed in to CUNY AI Lab. You can close this tab.")
        finish({ value })
      },
      (error: Error) => {
        send(502, "Sign-in failed", `${error.message} Return to OpenCode to try again.`)
        finish({ error })
      },
    )
  })
  const listening = server
  await new Promise<void>((onListen, onError) => {
    listening.once("error", onError)
    listening.listen(0, "127.0.0.1", () => {
      listening.off("error", onError)
      onListen()
    })
  })
  const address = listening.address()
  if (!address || typeof address === "string") {
    finish({ error: new Error("OpenCode could not start its sign-in helper.") })
    throw new Error("OpenCode could not start its sign-in helper.")
  }
  return {
    redirectUri: `http://127.0.0.1:${address.port}${CALLBACK_PATH}`,
    result,
    close: () => finish({ error: new Error("Sign-in cancelled") }),
  }
}
