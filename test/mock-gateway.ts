/**
 * A stand-in for the CUNY AI Lab gateway and Model Access API, for tests.
 *
 * - `GET /v1/models` serves the recorded catalog in test/fixtures.
 * - `POST /model-access/v1/connect/token` trades a code issued by `issueCode`
 *   for a fake personal key, once, after checking the PKCE verifier.
 * - `POST /v1/chat/completions` streams a fixed reply when the request carries
 *   an issued key, and answers 401 otherwise.
 */
import { createHash, randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { createServer, type IncomingMessage } from "node:http"

export const REPLY = "pong from the mock CUNY AI Lab gateway"

const catalog = readFileSync(new URL("./fixtures/models.json", import.meta.url), "utf8")

export interface TokenRequest {
  readonly code: string
  readonly code_verifier: string
  readonly replace_key_id?: string
}

export interface MockGateway {
  readonly origin: string
  /** Approve a sign-in the way the connect page does, and return its one-time code. */
  issueCode(challenge: string, device?: string): string
  readonly tokenRequests: TokenRequest[]
  readonly chatRequests: { model: string; authorization: string | undefined }[]
  readonly keys: string[]
  close(): Promise<void>
}

const fakeKey = () => `sk-cail-p_${randomBytes(16).toString("hex")}_${randomBytes(30).toString("base64url").replace(/[-_]/g, "a").slice(0, 40)}`

function keyId(key: string) {
  const hex = /^sk-cail-p_([0-9a-f]{32})_/.exec(key)?.[1] ?? ""
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}

export async function startMockGateway(): Promise<MockGateway> {
  const grants = new Map<string, { challenge: string; device: string }>()
  const tokenRequests: TokenRequest[] = []
  const chatRequests: MockGateway["chatRequests"] = []
  const keys: string[] = []
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" })
      response.end(JSON.stringify(body))
    }
    if (request.method === "GET" && url.pathname === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(catalog)
      return
    }
    if (request.method === "POST" && url.pathname === "/model-access/v1/connect/token") {
      const body = JSON.parse(await readBody(request)) as TokenRequest
      tokenRequests.push(body)
      const grant = grants.get(body.code)
      grants.delete(body.code)
      const challenge = createHash("sha256").update(body.code_verifier ?? "").digest("base64url")
      if (!grant || grant.challenge !== challenge) {
        json(400, { error: "invalid_grant", message: "This sign-in code is no longer valid. Sign in again from the app." })
        return
      }
      // Like the Lab, a sign-in that names an earlier key revokes it.
      if (body.replace_key_id) {
        const index = keys.findIndex((existing) => keyId(existing) === body.replace_key_id)
        if (index !== -1) keys.splice(index, 1)
      }
      const key = fakeKey()
      keys.push(key)
      json(201, {
        key,
        credential: {
          id: "01234567-89ab-4cde-8123-456789abcdef",
          label: `OpenCode on ${grant.device}`,
          status: "active",
          expiresAt: Date.now() + 180 * 24 * 60 * 60 * 1000,
        },
      })
      return
    }
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      const body = JSON.parse(await readBody(request)) as { model: string; stream?: boolean }
      const authorization = request.headers.authorization
      chatRequests.push({ model: body.model, authorization })
      if (!keys.some((key) => authorization === `Bearer ${key}`)) {
        json(401, { error: { message: "The API credential is invalid or expired.", code: "invalid_credential" } })
        return
      }
      const base = { id: "chatcmpl-mock", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model }
      if (body.stream === false) {
        json(200, {
          ...base,
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: REPLY }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
        return
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
      const send = (chunk: unknown) => response.write(`data: ${JSON.stringify(chunk)}\n\n`)
      send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: REPLY }, finish_reason: null }] })
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
      response.end("data: [DONE]\n\n")
      return
    }
    json(404, { error: "not_found" })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("mock gateway did not bind")
  return {
    origin: `http://127.0.0.1:${address.port}`,
    issueCode(challenge, device = "test-laptop") {
      const code = randomBytes(32).toString("base64url")
      grants.set(code, { challenge, device })
      return code
    },
    tokenRequests,
    chatRequests,
    keys,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
