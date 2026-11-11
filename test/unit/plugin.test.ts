import { describe, expect, test } from "bun:test"
import { createPlugin } from "../../src/index.js"
import { EXPIRED_MESSAGE, pkcePair } from "../../src/signin.js"
import catalog from "../fixtures/models.json" with { type: "json" }

const KEY_1 = `sk-cail-p_${"1".repeat(32)}_${"a".repeat(40)}`
const KEY_2 = `sk-cail-p_${"2".repeat(32)}_${"b".repeat(40)}`
const LAB = "https://lab.test"

type Method = { method: { id?: string; type: string; label?: string; names?: string[] }; [key: string]: any }

/** Just enough of OpenCode's plugin context to run the plugin and inspect what it registers. */
function fakeOpenCode(options: { stored?: { type: "oauth" | "key"; access?: string; key?: string }; defaultModel?: string } = {}) {
  const storage = new Map<string, unknown>()
  type Entry = { name: string; methods: Method[] }
  const integrations = new Map<string, Entry>()
  const providers: any[] = []
  const statuses: unknown[] = []
  const calls = { providerReload: 0 }
  let providerTransform: ((editor: any) => void) | undefined
  let modelTransform: ((editor: any) => void) | undefined
  let stored = options.stored

  const ctx: any = {
    options: {},
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => void storage.set(key, value),
    },
    integration: {
      transform: async (callback: (editor: any) => void) => {
        callback({
          update: (id: string, update: (integration: { name: string }) => void) => {
            const current: Entry = integrations.get(id) ?? { name: id, methods: [] }
            update(current)
            integrations.set(id, current)
          },
          method: {
            update: (registration: Method) => {
              const current: Entry = integrations.get(registration.integrationID) ?? { name: registration.integrationID, methods: [] }
              current.methods.push(registration)
              integrations.set(registration.integrationID, current)
            },
          },
        })
      },
      connection: {
        active: async () => (stored ? { type: "credential", id: "cred_1", label: "old", method: stored.type } : undefined),
        resolve: async () => stored,
        status: async (input: unknown) => void statuses.push(input),
      },
    },
    provider: {
      transform: async (callback: (editor: any) => void) => {
        providerTransform = callback
      },
      reload: async () => void calls.providerReload++,
    },
    model: {
      transform: async (callback: (editor: any) => void) => {
        modelTransform = callback
      },
    },
  }

  return {
    ctx,
    storage,
    statuses,
    calls,
    setStored: (value: typeof stored) => (stored = value),
    methods: () => integrations.get("cail")?.methods ?? [],
    method: (id: string) => integrations.get("cail")?.methods.find((entry) => entry.method.id === id)!,
    integrationName: () => integrations.get("cail")?.name,
    providers: () => {
      providers.length = 0
      providerTransform?.({ add: (entry: unknown) => providers.push(entry) })
      return providers
    },
    defaultFor: (models: { id: string }[]) => {
      let chosen = options.defaultModel ? { providerID: "other", modelID: options.defaultModel } : undefined
      modelTransform?.({
        list: () => models,
        default: { get: () => chosen, set: (providerID: string, modelID: string) => (chosen = { providerID, modelID }) },
      })
      return chosen
    },
  }
}

/** The gateway and Model Access API: the catalog, and a token exchange that records its requests. */
function labFetch() {
  const tokenRequests: Record<string, string>[] = []
  let catalogRequests = 0
  const fetch = (async (url: string, init: RequestInit = {}) => {
    if (String(url).endsWith("/v1/models")) {
      catalogRequests++
      return Response.json(catalog)
    }
    tokenRequests.push(JSON.parse(String(init.body)))
    const key = tokenRequests.length === 1 ? KEY_1 : KEY_2
    return Response.json(
      { key, credential: { expiresAt: Date.now() + 1_000_000, label: "OpenCode on laptop" } },
      { status: 201 },
    )
  }) as unknown as typeof globalThis.fetch
  return { fetch, tokenRequests, catalogRequests: () => catalogRequests }
}

async function waitFor<T>(read: () => T | undefined, ms = 2000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = read()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("timed out waiting")
}

async function load(fake: ReturnType<typeof fakeOpenCode>, lab = labFetch()) {
  const cleanup = await createPlugin({ origin: LAB, hostname: "laptop.local", fetch: lab.fetch }).setup(fake.ctx)
  return { lab, cleanup: cleanup as () => void }
}

describe("plugin", () => {
  test("adds CUNY AI Lab with browser, code, key and environment sign-in", async () => {
    const fake = fakeOpenCode()
    const { cleanup } = await load(fake)
    expect(fake.integrationName()).toBe("CUNY AI Lab")
    expect(fake.methods().map((entry) => entry.method)).toEqual([
      { id: "browser", type: "oauth", label: "Sign in with CUNY AI Lab" },
      { id: "code", type: "oauth", label: "Sign in with CUNY AI Lab using a code" },
      { type: "key", label: "CUNY AI Lab API key" },
      { type: "env", names: ["AILAB_API_KEY"] },
    ])
    cleanup()
  })

  test("registers the gateway as an OpenAI-compatible provider tied to the sign-in", async () => {
    const fake = fakeOpenCode()
    const { lab, cleanup } = await load(fake)
    await waitFor(() => fake.calls.providerReload > 0 || undefined)
    const [provider] = fake.providers()
    expect(provider.info).toMatchObject({
      id: "cail",
      integrationID: "cail",
      name: "CUNY AI Lab",
      activation: "auto",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `${LAB}/v1` },
    })
    expect(provider.models.length).toBeGreaterThan(30)
    expect(lab.catalogRequests()).toBe(1)
    expect(fake.storage.get("catalog")).toEqual(catalog)
    cleanup()
  })

  test("lists the last catalog at startup when the gateway cannot be reached", async () => {
    const fake = fakeOpenCode()
    fake.storage.set("catalog", catalog)
    const offline = (async () => {
      throw new TypeError("fetch failed")
    }) as unknown as typeof globalThis.fetch
    const cleanup = (await createPlugin({ origin: LAB, fetch: offline }).setup(fake.ctx)) as () => void
    expect(fake.providers()[0].models.length).toBeGreaterThan(30)
    expect(fake.calls.providerReload).toBe(0)
    cleanup()
  })

  test("the browser method signs in through the loopback callback", async () => {
    const fake = fakeOpenCode()
    const { lab, cleanup } = await load(fake)
    const authorization = await fake.method("browser").authorize({})
    expect(authorization.mode).toBe("auto")
    const url = new URL(authorization.url)
    expect(`${url.origin}${url.pathname}`).toBe(`${LAB}/model-access/connect`)
    expect(url.searchParams.get("client")).toBe("opencode")
    expect(url.searchParams.get("device")).toBe("laptop")
    const redirect = url.searchParams.get("redirect_uri")!
    const page = await fetch(`${redirect}?code=${"c".repeat(43)}&state=${url.searchParams.get("state")}`)
    expect(await page.text()).toContain("OpenCode is connected")
    const credential = await authorization.callback
    expect(credential).toMatchObject({ type: "oauth", methodID: "browser", access: KEY_1, refresh: "" })
    expect(fake.method("browser").label(credential)).toMatch(/^OpenCode on laptop, signed in \d{4}-\d{2}-\d{2}$/)
    const sent = lab.tokenRequests[0]!
    expect(sent.code).toBe("c".repeat(43))
    expect(sent.replace_key_id).toBeUndefined()
    const digest = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sent.code_verifier)))
    expect(digest.toString("base64url")).toBe(url.searchParams.get("code_challenge")!)
    cleanup()
  })

  test("signing in again replaces this computer's key and marks the old account", async () => {
    const fake = fakeOpenCode({ stored: { type: "oauth", access: KEY_1 } })
    const { lab, cleanup } = await load(fake)
    const authorization = await fake.method("code").authorize({})
    expect(authorization.mode).toBe("code")
    expect(new URL(authorization.url).searchParams.has("redirect_uri")).toBe(false)
    const credential = await authorization.callback("c".repeat(43))
    expect(credential.methodID).toBe("code")
    expect(lab.tokenRequests[0]!.replace_key_id).toBe("11111111-1111-1111-1111-111111111111")
    expect(fake.statuses).toEqual([
      expect.objectContaining({ integrationID: "cail", status: expect.objectContaining({ status: "needs_auth" }) }),
    ])
    cleanup()
  })

  test("a pasted key is never replaced", async () => {
    const fake = fakeOpenCode({ stored: { type: "key", key: KEY_1 } })
    const { lab, cleanup } = await load(fake)
    await (await fake.method("code").authorize({})).callback("c".repeat(43))
    expect(lab.tokenRequests[0]!.replace_key_id).toBeUndefined()
    expect(fake.statuses).toEqual([])
    cleanup()
  })

  test("an expired sign-in asks the member to sign in again", async () => {
    const fake = fakeOpenCode()
    const { cleanup } = await load(fake)
    const refresh = fake.method("browser").refresh
    const live = { type: "oauth", access: KEY_1, refresh: "", expires: Date.now() + 60_000 }
    expect(await refresh(live)).toBe(live)
    await expect(refresh({ ...live, expires: Date.now() - 1 })).rejects.toThrow(EXPIRED_MESSAGE)
    cleanup()
  })

  test("defaults to the newest DeepSeek Flash only when no default is set", async () => {
    const models = [{ id: "glm-5.3" }, { id: "deepseek-v4-flash-0731" }, { id: "deepseek-v4.1-flash-1017" }]
    const unset = fakeOpenCode()
    const first = await load(unset)
    expect(unset.defaultFor(models)).toEqual({ providerID: "cail", modelID: "deepseek-v4.1-flash-1017" })
    first.cleanup()

    const chosen = fakeOpenCode({ defaultModel: "claude-sonnet-5-5" })
    const second = await load(chosen)
    expect(chosen.defaultFor(models)).toEqual({ providerID: "other", modelID: "claude-sonnet-5-5" })
    second.cleanup()
  })

  test("PKCE pairs are fresh for every sign-in", () => {
    expect(pkcePair().verifier).not.toBe(pkcePair().verifier)
  })
})
