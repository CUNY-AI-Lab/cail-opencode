/**
 * CUNY AI Lab model catalog → OpenCode `Model.Info[]`.
 *
 * Availability and capability metadata both come from the live gateway:
 * `GET https://tools.ailab.gc.cuny.edu/v1/models` returns OpenAI-style entries
 * enriched with `name`, `task`, `capabilities`, `context_length`, `pricing`,
 * `status` and `sunset`. The public catalog at ailab.gc.cuny.edu/models reads
 * the same data, so the plugin ships no model list.
 *
 * Only text-generation models that accept tool calls are offered, because
 * OpenCode sends its tools on every request and the gateway rejects tool calls
 * to models without function calling. Speech, image and sunset models are
 * dropped.
 *
 * Pure functions, no I/O.
 */
import type { Model, Provider } from "@opencode/plugin"

export const PROVIDER_ID = "cail"
export const PROVIDER_NAME = "CUNY AI Lab"
export const DEFAULT_ORIGIN = "https://tools.ailab.gc.cuny.edu"

const DEFAULT_CONTEXT = 128_000
const MAX_OUTPUT = 32_000

export class CatalogError extends Error {
  override name = "CatalogError"
}

export interface CatalogEntry {
  readonly id: string
  readonly [field: string]: unknown
}

/** Validate the OpenAI-style list shape and return entries with usable ids. */
export function parseCatalog(payload: unknown): CatalogEntry[] {
  const data = (payload as { data?: unknown } | null)?.data
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(data)) {
    throw new CatalogError("CUNY AI Lab did not return a standard model list (expected { data: [...] }).")
  }
  return data.filter(
    (entry): entry is CatalogEntry =>
      !!entry && typeof entry === "object" && typeof entry.id === "string" && entry.id.trim() !== "",
  )
}

function capabilities(entry: CatalogEntry): string[] {
  return Array.isArray(entry.capabilities)
    ? entry.capabilities.filter((capability): capability is string => typeof capability === "string")
    : []
}

function isTextGeneration(entry: CatalogEntry) {
  const caps = capabilities(entry)
  if (caps.length > 0) return caps.includes("text-generation")
  if (typeof entry.task === "string") return /text generation/i.test(entry.task)
  // No capability information at all: offer the model with conservative defaults.
  return true
}

function supportsTools(entry: CatalogEntry) {
  const caps = capabilities(entry)
  return caps.length === 0 || caps.includes("function-calling")
}

function isRetired(entry: CatalogEntry, now: number) {
  if (typeof entry.status === "string" && /^(retired|disabled|inactive|removed)$/i.test(entry.status)) return true
  if (typeof entry.sunset === "string") {
    const sunset = Date.parse(entry.sunset)
    if (!Number.isNaN(sunset) && sunset <= now) return true
  }
  return false
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

function cost(entry: CatalogEntry): Model.Info["cost"] {
  const pricing = entry.pricing as { currency?: unknown; unit?: unknown; input?: unknown; output?: unknown } | undefined
  if (!pricing || pricing.currency !== "USD" || pricing.unit !== "million_tokens") return []
  const price = (value: unknown) =>
    (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0) as Model.Info["cost"][number]["input"]
  const zero = price(0)
  return [{ input: price(pricing.input), output: price(pricing.output), cache: { read: zero, write: zero } }]
}

export function toModel(entry: CatalogEntry): Model.Info {
  const caps = capabilities(entry)
  const context = positiveInteger(entry.context_length) ?? DEFAULT_CONTEXT
  const name =
    (typeof entry.name === "string" && entry.name.trim()) ||
    (typeof entry.model_name === "string" && entry.model_name.trim()) ||
    entry.id
  return {
    id: entry.id as Model.ID,
    modelID: entry.id as Model.ID,
    providerID: PROVIDER_ID as Provider.ID,
    name,
    capabilities: {
      tools: true,
      input: caps.includes("vision") ? ["text", "image"] : ["text"],
      output: ["text"],
    },
    variants: [],
    time: { released: 0 },
    cost: cost(entry),
    status: "active",
    enabled: true,
    limit: { context, output: Math.min(MAX_OUTPUT, Math.max(1024, Math.floor(context / 2))) },
  }
}

const DEEPSEEK_FLASH = /^deepseek-v(\d+(?:\.\d+)?)-flash(?:-(\d+))?$/i

/**
 * The newest DeepSeek Flash, or undefined. Newer means a higher version
 * (v4 before v4.1), then a higher release suffix (0731 before 1017).
 */
export function newestDeepSeekFlash<T extends { id: string }>(models: readonly T[]): T | undefined {
  let best: T | undefined
  let bestRank: [number, number] = [-1, -1]
  for (const model of models) {
    const match = DEEPSEEK_FLASH.exec(model.id)
    if (!match) continue
    const rank: [number, number] = [Number(match[1]), Number(match[2] ?? 0)]
    if (rank[0] > bestRank[0] || (rank[0] === bestRank[0] && rank[1] > bestRank[1])) {
      best = model
      bestRank = rank
    }
  }
  return best
}

/** Convert a raw `/v1/models` payload into OpenCode models. Throws CatalogError when the payload is malformed. */
/**
 * Models in the lab's curated order (the catalog's `order`; entries without
 * one keep their catalog position after the rest), with the newest DeepSeek
 * Flash first. OpenCode lists a new provider's models in this order right
 * after sign-in and preselects the first, so the first is the default model.
 */
export function toModels(payload: unknown, { now = Date.now() }: { now?: number } = {}): Model.Info[] {
  const models = parseCatalog(payload)
    .filter((entry) => isTextGeneration(entry) && supportsTools(entry) && !isRetired(entry, now))
    .sort((a, b) => catalogRank(a) - catalogRank(b))
    .map(toModel)
  const flash = newestDeepSeekFlash(models)
  return flash ? [flash, ...models.filter((model) => model !== flash)] : models
}

function catalogRank(entry: CatalogEntry): number {
  return typeof entry.order === "number" && Number.isFinite(entry.order) ? entry.order : Number.MAX_SAFE_INTEGER
}
