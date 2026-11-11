import { describe, expect, test } from "bun:test"
import { CatalogError, newestDeepSeekFlash, parseCatalog, toModel, toModels } from "../../src/catalog.js"
import catalog from "../fixtures/models.json" with { type: "json" }

describe("catalog", () => {
  test("offers only text models that accept tool calls", () => {
    const models = toModels(catalog)
    const ids: string[] = models.map((model) => model.id)
    expect(models.length).toBe(
      catalog.data.filter(
        (entry) =>
          entry.capabilities?.includes("text-generation") && entry.capabilities.includes("function-calling"),
      ).length,
    )
    expect(ids).toContain("deepseek-v4.1-flash-1017")
    expect(ids).not.toContain("whisper-large-v3-turbo")
    expect(models.every((model) => model.providerID === "cail" && model.capabilities.tools)).toBe(true)
  })

  test("maps names, vision, context, output limit and prices", () => {
    const model = toModel({
      id: "vision-model",
      name: "Vision Model",
      capabilities: ["text-generation", "function-calling", "vision"],
      context_length: 262_144,
      pricing: { currency: "USD", unit: "million_tokens", input: 0.2, output: 0.88 },
    })
    expect(model.name).toBe("Vision Model")
    expect(model.capabilities.input).toEqual(["text", "image"])
    expect(model.limit).toEqual({ context: 262_144, output: 32_000 })
    expect(model.cost).toEqual([{ input: 0.2, output: 0.88, cache: { read: 0, write: 0 } }] as never)
  })

  test("uses conservative defaults when the catalog says little", () => {
    const model = toModel({ id: "bare" })
    expect(model.name).toBe("bare")
    expect(model.capabilities.input).toEqual(["text"])
    expect(model.limit).toEqual({ context: 128_000, output: 32_000 })
    expect(model.cost).toEqual([])
  })

  test("drops sunset and retired models", () => {
    const now = Date.parse("2026-11-10T00:00:00Z")
    const models = toModels(
      {
        data: [
          { id: "current", capabilities: ["text-generation", "function-calling"] },
          { id: "sunset", capabilities: ["text-generation", "function-calling"], sunset: "2026-11-01" },
          { id: "later", capabilities: ["text-generation", "function-calling"], sunset: "2027-01-01" },
          { id: "retired", capabilities: ["text-generation", "function-calling"], status: "retired" },
        ],
      },
      { now },
    )
    expect(models.map((model) => model.id as string)).toEqual(["current", "later"])
  })

  test("lists models in the lab's order, with the newest DeepSeek Flash first", () => {
    const tools = ["text-generation", "function-calling"]
    const models = toModels({
      data: [
        { id: "unordered-a", capabilities: tools },
        { id: "third", capabilities: tools, order: 9 },
        { id: "deepseek-v4.1-flash-1017", capabilities: tools, order: 5 },
        { id: "first", capabilities: tools, order: 1 },
        { id: "unordered-b", capabilities: tools },
        { id: "second", capabilities: tools, order: 2 },
      ],
    })
    expect(models.map((model) => model.id as string)).toEqual([
      "deepseek-v4.1-flash-1017",
      "first",
      "second",
      "third",
      "unordered-a",
      "unordered-b",
    ])

    const live = toModels(catalog).map((model) => model.id as string)
    expect(live[0]).toBe("deepseek-v4.1-flash-1017")
    expect(live.slice(1, 4)).toEqual(["glm-5.3", "qwen3.8-27b", "gpt-oss-120b"])
  })

  test("rejects a response that is not a model list", () => {
    expect(() => parseCatalog({ models: [] })).toThrow(CatalogError)
    expect(() => parseCatalog(null)).toThrow(CatalogError)
    expect(parseCatalog({ data: [{ id: "" }, { id: "ok" }, null] }).map((entry) => entry.id)).toEqual(["ok"])
  })

  test("picks the newest DeepSeek Flash by version, then release", () => {
    const pick = (ids: string[]) => newestDeepSeekFlash(ids.map((id) => ({ id })))?.id
    expect(pick(["deepseek-v4-flash-0731", "deepseek-v4.1-flash-1017", "deepseek-v4-pro-0813"])).toBe(
      "deepseek-v4.1-flash-1017",
    )
    expect(pick(["deepseek-v4-flash-0731", "deepseek-v4-flash-1015"])).toBe("deepseek-v4-flash-1015")
    expect(pick(["glm-5.3"])).toBeUndefined()
  })
})
