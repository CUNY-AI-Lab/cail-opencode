/**
 * CUNY AI Lab for OpenCode.
 *
 * Adds "CUNY AI Lab" to OpenCode's providers, with "Sign in with CUNY AI Lab"
 * in the app's connect dialog, the Lab's models listed live from the gateway,
 * and the newest DeepSeek Flash as the default model when no default is set.
 *
 * The plugin is a plain object: OpenCode's `Plugin.define` only returns its
 * argument, so the published package has no runtime dependencies.
 */
import type { Credential, Model, Plugin, Provider } from "@opencode/plugin"
import { DEFAULT_ORIGIN, PROVIDER_ID, PROVIDER_NAME, newestDeepSeekFlash, toModels } from "./catalog.js"
import {
  EXPIRED_MESSAGE,
  SIGN_IN_TIMEOUT_MS,
  codeFromInput,
  connectUrl,
  deviceName,
  exchangeCode,
  keyIdFromKey,
  pkcePair,
  randomState,
  startCallbackServer,
  type CallbackServer,
  type IssuedKey,
} from "./signin.js"

export const PLUGIN_ID = "cail"
const BROWSER_METHOD = "browser"
const CODE_METHOD = "code"
const CATALOG_KEY = "catalog"
const CATALOG_TIMEOUT_MS = 10_000
const CATALOG_REFRESH_MS = 15 * 60 * 1000

export interface Options {
  /** The Lab's origin. Only tests set this. */
  readonly origin?: string
  /** Hostname override for the key name. Only tests set this. */
  readonly hostname?: string
  /** Fetch override. Only tests set this. */
  readonly fetch?: typeof globalThis.fetch
}

function origin(options: Plugin.Context["options"]) {
  const value = options.origin
  return typeof value === "string" && /^https?:\/\/[^/]+$/.test(value) ? value : DEFAULT_ORIGIN
}

export function createPlugin(overrides: Options = {}): Plugin.Plugin {
  return {
    id: PLUGIN_ID,
    async setup(ctx) {
      const lab = overrides.origin ?? origin(ctx.options)
      const fetch = overrides.fetch ?? globalThis.fetch
      const device = deviceName(
        overrides.hostname ?? (typeof ctx.options.hostname === "string" ? ctx.options.hostname : undefined),
      )

      // The last catalog read keeps models listed when OpenCode starts offline.
      const cached = await ctx.storage.get(CATALOG_KEY).catch(() => undefined)
      const state = { models: modelsFrom(cached), raw: JSON.stringify(cached ?? null) }

      const credential = (issued: IssuedKey, methodID: string): Credential.OAuth => ({
        type: "oauth",
        methodID: methodID as Credential.OAuth["methodID"],
        access: issued.key,
        refresh: "",
        expires: issued.expires,
        metadata: { signedIn: new Date().toISOString().slice(0, 10), ...(issued.keyName ? { keyName: issued.keyName } : {}) },
      })

      // A new sign-in replaces the key from this computer's last sign-in. A
      // pasted key is a "key" credential and is never replaced.
      const previousSignIn = async () => {
        try {
          const connection = await ctx.integration.connection.active(PROVIDER_ID)
          if (!connection) return undefined
          const value = await ctx.integration.connection.resolve(connection)
          const keyId = value?.type === "oauth" ? keyIdFromKey(value.access) : undefined
          return keyId ? { connection, keyId } : undefined
        } catch {
          return undefined
        }
      }

      // OpenCode keeps every sign-in as its own account and plugins cannot
      // remove one, so mark the account whose key the Lab just replaced.
      const signIn = async (
        previous: Awaited<ReturnType<typeof previousSignIn>>,
        exchange: (replaceKeyId: string | undefined) => Promise<IssuedKey>,
        methodID: string,
      ) => {
        const issued = await exchange(previous?.keyId)
        if (previous) {
          await ctx.integration.connection
            .status({
              integrationID: PROVIDER_ID,
              connection: previous.connection,
              status: {
                status: "needs_auth",
                message: "Replaced by a newer CUNY AI Lab sign-in. You can remove this account.",
              },
            })
            .catch(() => {})
        }
        return credential(issued, methodID)
      }

      let pending: CallbackServer<Credential.OAuth> | undefined
      const refresh = async (value: Credential.OAuth) => {
        if (value.expires > Date.now()) return value
        throw new Error(EXPIRED_MESSAGE)
      }

      await ctx.integration.transform((editor) => {
        editor.update(PROVIDER_ID, (integration) => {
          integration.name = PROVIDER_NAME
        })
        editor.method.update({
          integrationID: PROVIDER_ID,
          method: { id: BROWSER_METHOD, type: "oauth", label: "Sign in with CUNY AI Lab" },
          refresh,
          label: (value) => labelFor(value),
          authorize: async () => {
            pending?.close()
            const { verifier, challenge } = pkcePair()
            const state = randomState()
            const previous = await previousSignIn()
            const server = await startCallbackServer({
              state,
              complete: (code) =>
                signIn(
                  previous,
                  (replaceKeyId) => exchangeCode({ code, verifier, replaceKeyId, origin: lab, fetch }),
                  BROWSER_METHOD,
                ),
            })
            pending = server
            return {
              mode: "auto",
              url: connectUrl(lab, { device, challenge, redirectUri: server.redirectUri, state }),
              instructions: "Sign in with your CUNY Login in the browser and click Connect OpenCode.",
              expiresAt: Date.now() + SIGN_IN_TIMEOUT_MS,
              callback: server.result,
            }
          },
        })
        editor.method.update({
          integrationID: PROVIDER_ID,
          method: { id: CODE_METHOD, type: "oauth", label: "Sign in with CUNY AI Lab using a code" },
          refresh,
          label: (value) => labelFor(value),
          authorize: async () => {
            const { verifier, challenge } = pkcePair()
            const previous = await previousSignIn()
            return {
              mode: "code",
              url: connectUrl(lab, { device, challenge }),
              instructions: "Sign in with your CUNY Login, click Connect OpenCode, and paste the code the page shows.",
              expiresAt: Date.now() + SIGN_IN_TIMEOUT_MS,
              callback: (input) =>
                signIn(
                  previous,
                  (replaceKeyId) =>
                    exchangeCode({ code: codeFromInput(input), verifier, replaceKeyId, origin: lab, fetch }),
                  CODE_METHOD,
                ),
            }
          },
        })
        editor.method.update({
          integrationID: PROVIDER_ID,
          method: { type: "key", label: "CUNY AI Lab API key" },
        })
        editor.method.update({
          integrationID: PROVIDER_ID,
          method: { type: "env", names: ["AILAB_API_KEY"] },
        })
      })

      await ctx.provider.transform((editor) => {
        editor.add({
          info: {
            id: PROVIDER_ID as Provider.ID,
            integrationID: PROVIDER_ID as NonNullable<Provider.Info["integrationID"]>,
            name: PROVIDER_NAME,
            activation: "auto",
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: `${lab}/v1`, provider: PROVIDER_ID },
          },
          models: state.models,
        })
      })

      // OpenCode falls back to the first available model, which can be a free
      // model from OpenCode's own service. Prefer the newest DeepSeek Flash
      // unless a default is already set, for example by `model` in the config.
      await ctx.model.transform((editor) => {
        if (editor.default.get()) return
        const preferred = newestDeepSeekFlash(editor.list(PROVIDER_ID))
        if (preferred) editor.default.set(PROVIDER_ID, preferred.id)
      })

      const load = async () => {
        let payload: unknown
        try {
          const response = await fetch(`${lab}/v1/models`, {
            headers: { accept: "application/json" },
            signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
          })
          if (!response.ok) return
          payload = await response.json()
          toModels(payload)
        } catch {
          // Keep the last good list through outages instead of flickering models.
          return
        }
        const raw = JSON.stringify(payload)
        if (raw === state.raw) return
        state.raw = raw
        state.models = toModels(payload)
        await ctx.storage.set(CATALOG_KEY, payload as never).catch(() => {})
        await ctx.provider.reload()
      }

      void load()
      const timer = setInterval(() => void load(), CATALOG_REFRESH_MS)
      return () => {
        clearInterval(timer)
        pending?.close()
      }
    },
  }
}

function modelsFrom(payload: unknown): Model.Info[] {
  try {
    return payload === undefined ? [] : toModels(payload)
  } catch {
    return []
  }
}

function labelFor(value: Credential.OAuth) {
  const name = value.metadata?.keyName
  const date = value.metadata?.signedIn
  if (typeof name !== "string") return undefined
  return typeof date === "string" ? `${name}, signed in ${date}` : name
}

export default createPlugin()
