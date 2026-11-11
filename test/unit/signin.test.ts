import { describe, expect, test } from "bun:test"
import {
  codeFromInput,
  connectUrl,
  deviceName,
  exchangeCode,
  isPersonalKey,
  keyIdFromKey,
  pkcePair,
  startCallbackServer,
} from "../../src/signin.js"

const KEY = `sk-cail-p_0123456789ab4cde8123456789abcdef_${"a".repeat(40)}`
const CODE = "c".repeat(43)
/** The Model Access API's accepted device names. */
const LAB_DEVICE = /^[A-Za-z0-9](?:[A-Za-z0-9._ -]{0,62}[A-Za-z0-9])?$/

function fetchStub(respond: () => Response) {
  const calls: { url: string; body: Record<string, string> }[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) })
    return respond()
  }) as unknown as typeof globalThis.fetch
  return Object.assign(fetch, { calls })
}

describe("sign-in pieces", () => {
  test("the device name is the hostname, cut to what the Lab accepts", () => {
    expect(deviceName("Stephens-MacBook-Pro.local")).toBe("Stephens-MacBook-Pro")
    expect(deviceName("José's Mac")).toBe("Jos-s Mac")
    expect(deviceName("---")).toBe("computer")
    for (const name of ["Stephens-MacBook-Pro.local", "José's Mac", `${"x".repeat(63)}-yz`, "---", "a"]) {
      expect(deviceName(name)).toMatch(LAB_DEVICE)
    }
  })

  test("a personal key carries its id", () => {
    expect(keyIdFromKey(KEY)).toBe("01234567-89ab-4cde-8123-456789abcdef")
    expect(keyIdFromKey(`sk-cail-d_${KEY.slice(10)}`)).toBeUndefined()
    expect(isPersonalKey(KEY)).toBe(true)
  })

  test("the challenge is the SHA-256 of the verifier", async () => {
    const { verifier, challenge } = pkcePair()
    const digest = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
    expect(challenge).toBe(digest.toString("base64url"))
  })

  test("the connect link names OpenCode and adds a callback only for the browser method", () => {
    const browser = new URL(
      connectUrl("https://lab.test", { device: "laptop", challenge: "c", redirectUri: "http://127.0.0.1:1/callback", state: "s" }),
    )
    expect(browser.pathname).toBe("/model-access/connect")
    expect(Object.fromEntries(browser.searchParams)).toEqual({
      client: "opencode",
      device: "laptop",
      code_challenge: "c",
      redirect_uri: "http://127.0.0.1:1/callback",
      state: "s",
    })
    const code = new URL(connectUrl("https://lab.test", { device: "laptop", challenge: "c" }))
    expect([...code.searchParams.keys()]).toEqual(["client", "device", "code_challenge"])
  })

  test("a pasted code or callback address yields the code", () => {
    expect(codeFromInput(`  ${CODE}\n`)).toBe(CODE)
    expect(codeFromInput(`http://127.0.0.1:5000/callback?code=${CODE}&state=s1`, "s1")).toBe(CODE)
    expect(() => codeFromInput(`http://127.0.0.1:5000/callback?code=${CODE}&state=x`, "s1")).toThrow(/different sign-in/)
    expect(() => codeFromInput("not a code")).toThrow(/not a CUNY AI Lab sign-in code/)
  })

  test("the exchange sends the code, verifier and key to replace", async () => {
    const fetch = fetchStub(() =>
      Response.json({ key: KEY, credential: { expiresAt: 1_900_000_000_000, label: "OpenCode on laptop" } }, { status: 201 }),
    )
    const issued = await exchangeCode({ code: CODE, verifier: "v", replaceKeyId: "id-1", origin: "https://lab.test", fetch })
    expect(issued).toEqual({ key: KEY, expires: 1_900_000_000_000, keyName: "OpenCode on laptop" })
    expect(fetch.calls[0]).toEqual({
      url: "https://lab.test/model-access/v1/connect/token",
      body: { code: CODE, code_verifier: "v", replace_key_id: "id-1" },
    })
  })

  test("exchange failures carry the Lab's message and never the key", async () => {
    const refused = fetchStub(() =>
      Response.json({ error: "invalid_grant", message: "This sign-in code is no longer valid." }, { status: 400 }),
    )
    await expect(exchangeCode({ code: CODE, verifier: "v", origin: "https://lab.test", fetch: refused })).rejects.toThrow(
      /no longer valid/,
    )
    const notAdmitted = fetchStub(() =>
      Response.json({ error: { code: "admission_required", message: "Your CUNY AI Lab access is not active yet." } }, { status: 403 }),
    )
    await expect(
      exchangeCode({ code: CODE, verifier: "v", origin: "https://lab.test", fetch: notAdmitted }),
    ).rejects.toThrow(/access is not active/)
    const malformed = fetchStub(() => Response.json({ key: "nope" }, { status: 201 }))
    await expect(exchangeCode({ code: CODE, verifier: "v", origin: "https://lab.test", fetch: malformed })).rejects.toThrow(
      /unexpected sign-in response/,
    )
    const offline = (async () => {
      throw new TypeError("fetch failed")
    }) as unknown as typeof globalThis.fetch
    await expect(exchangeCode({ code: CODE, verifier: "v", origin: "https://lab.test", fetch: offline })).rejects.toThrow(
      /could not reach CUNY AI Lab/,
    )
  })
})

describe("loopback callback", () => {
  test("finishes the exchange before answering the browser, then closes", async () => {
    const codes: string[] = []
    const server = await startCallbackServer({
      state: "state-1",
      complete: async (code) => {
        codes.push(code)
        return "credential"
      },
    })
    expect(server.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    expect((await fetch(`${server.redirectUri}?code=${CODE}&state=wrong`)).status).toBe(404)
    const page = await fetch(`${server.redirectUri}?code=${CODE}&state=state-1`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain("OpenCode is connected")
    expect(await server.result).toBe("credential")
    expect(codes).toEqual([CODE])
    await expect(fetch(server.redirectUri)).rejects.toThrow()
  })

  test("shows the Lab's error and rejects when the exchange fails", async () => {
    const server = await startCallbackServer({
      state: "s",
      complete: async () => {
        throw new Error("Your CUNY AI Lab access is not active yet.")
      },
    })
    const page = await fetch(`${server.redirectUri}?code=${CODE}&state=s`)
    expect(page.status).toBe(502)
    expect(await page.text()).toContain("access is not active")
    await expect(server.result).rejects.toThrow(/access is not active/)
  })

  test("Cancel on the consent page and timeouts end the sign-in", async () => {
    const cancelled = await startCallbackServer({ state: "s", complete: async () => "x" })
    const page = await fetch(`${cancelled.redirectUri}?error=access_denied&state=s`)
    expect(await page.text()).toContain("Sign-in cancelled")
    await expect(cancelled.result).rejects.toThrow(/cancelled/)

    const slow = await startCallbackServer({ state: "s", complete: async () => "x", timeoutMs: 20 })
    await expect(slow.result).rejects.toThrow(/timed out/)
  })
})
