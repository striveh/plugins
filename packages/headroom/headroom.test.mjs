import { readFileSync } from "node:fs"
import { expect, test, afterEach } from "bun:test"
import * as mod from "./headroom.hooks.js"
import { check } from "../../scripts/middleware.mjs"

check(import.meta.dir, mod)

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))

function ctx(over = {}) {
  const { options, report, signal, ...rest } = over
  return {
    protocol: "anthropic", model: "claude-sonnet", agent: "claude", session: "ses_1", stream: false,
    options: { agents: ["claude"], protect_cache: true, timeout_ms: 1000, ...(options ?? {}) },
    state: {}, signal, report, ...rest,
  }
}

function answer(body, capture) {
  return async (url, init) => {
    if (capture) {
      capture.url = url
      capture.init = init
      capture.body = JSON.parse(init.body)
      capture.headers = init.headers
    }
    return { ok: true, status: 200, json: async () => body }
  }
}

test("the published example compresses nothing", async () => {
  let called = false
  globalThis.fetch = () => { called = true; throw new Error("fetch") }
  const body = { model: "m", messages: [{ role: "user", content: "x".repeat(4000) }] }
  expect(await mod.onRequest(body, { protocol: "anthropic", agent: "claude", model: "m", options: pkg.magpie.options })).toBeUndefined()
  expect(called).toBe(false)
  expect(pkg.magpie.hooks).toBe("./headroom.hooks.js")
  expect(pkg.magpie.options.agents).toEqual([])
  expect(pkg.magpie.options.models).toEqual([])
  expect(pkg.main).toBeUndefined()
})

test("Anthropic: only the tail after the last cache_control is compressed", async () => {
  const prefix = { role: "user", content: [{ type: "text", text: "cached history", cache_control: { type: "ephemeral" } }] }
  const tail = { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "x".repeat(2000) }] }
  const compressedTail = { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "short" }] }
  const seen = {}
  globalThis.fetch = answer({
    messages: [{ role: "user", content: [{ text: "cached history", type: "text", cache_control: { type: "ephemeral" } }] }, compressedTail],
    tokens_saved: 1800,
  }, seen)
  const tools = [{ name: "read", input_schema: { type: "object" } }]
  const body = { model: "claude-sonnet", stream: true, system: "You code.", tools, messages: [prefix, tail] }
  const reports = []
  const got = await mod.onRequest(body, ctx({ report: (c, n) => reports.push([c, n]) }))
  expect(seen.body).toEqual({
    messages: body.messages,
    model: "claude-sonnet",
    config: { compress_user_messages: true, frozen_message_count: 1 },
  })
  expect(seen.body.gateway).toBeUndefined()
  expect(seen.body.tools).toBeUndefined()
  expect(seen.body.system).toBeUndefined()
  expect(seen.url).toBe("http://127.0.0.1:8787/v1/compress")
  expect(seen.init.method).toBe("POST")
  expect(seen.init.redirect).toBe("error")
  expect(got.messages[0]).toBe(prefix)
  expect(got.messages[1]).toEqual(compressedTail)
  expect(got.tools).toBe(tools)
  expect(got.system).toBe("You code.")
  expect(got.model).toBe("claude-sonnet")
  expect(got.stream).toBe(true)
  expect(reports).toEqual([["ready", 1800]])
  expect(body.messages[1]).toBe(tail)
})

test("a cache breakpoint on the last message does not call Headroom", async () => {
  let called = false
  globalThis.fetch = () => { called = true }
  const body = { model: "m", messages: [{ role: "user", content: [{ type: "text", text: "all cached", cache_control: { type: "ephemeral" } }] }] }
  expect(await mod.onRequest(body, ctx())).toBeUndefined()
  expect(called).toBe(false)
})

test("Chat: history before the latest user turn stays, and the tail is replaced", async () => {
  const history = [{ role: "system", content: "Be brief." }, { role: "user", content: "earlier" }, { role: "assistant", content: "ok" }]
  const tail = { role: "user", content: "please compress this tool dump ".repeat(50) }
  const compressed = { role: "user", content: "compressed" }
  const seen = {}
  globalThis.fetch = answer({ messages: [...history, compressed], tokens_saved: 40.9 }, seen)
  const body = { model: "gpt-4o", messages: [...history, tail] }
  const got = await mod.onRequest(body, ctx({ protocol: "chat", model: "gpt-4o", options: { models: ["gpt-"] } }))
  expect(seen.body.config.frozen_message_count).toBe(3)
  expect(got.messages.slice(0, 3)).toEqual(history)
  expect(got.messages[0]).toBe(body.messages[0])
  expect(got.messages[3]).toEqual(compressed)
})

test("Responses input items stay in order and function_call ids are required", async () => {
  const prefix = { type: "message", role: "user", content: [{ type: "input_text", text: "cached" }] }
  const call = { type: "function_call", call_id: "call_1", name: "read", arguments: "{\"path\":\"a\"}" }
  const output = { type: "function_call_output", call_id: "call_1", output: "y".repeat(1500) }
  const compressed = { type: "function_call_output", call_id: "call_1", output: "short" }
  const seen = {}
  globalThis.fetch = answer({ messages: [prefix, call, { ...output, output: "nope" }, compressed] }, seen)
  const body = { model: "gpt-4o", input: [prefix, call, output, { type: "function_call_output", call_id: "call_9", output: "tail" }] }
  // The last item's call_id changed. Reject the whole result.
  expect(await mod.onRequest(body, ctx({ protocol: "responses", options: { agents: ["claude"] } }))).toBeUndefined()
  expect(body.input[2]).toBe(output)

  globalThis.fetch = answer({ messages: [prefix, call, compressed, body.input[3]], tokens_saved: 10 }, seen)
  const got = await mod.onRequest(body, ctx({ protocol: "responses" }))
  expect(seen.body.messages).toEqual(body.input)
  expect(got.input[0]).toBe(prefix)
  expect(got.input[1]).toBe(call)
  expect(got.input[2]).toEqual(compressed)
  expect(got.model).toBe("gpt-4o")
})

test("a Responses string input comes back as a string", async () => {
  const seen = {}
  globalThis.fetch = answer({ messages: [{ role: "user", content: "short" }], tokens_saved: 3 }, seen)
  const got = await mod.onRequest({ model: "gpt-4o", input: "a long plain prompt ".repeat(40) }, ctx({ protocol: "responses", options: { protect_cache: false } }))
  expect(seen.body.messages).toEqual([{ role: "user", content: "a long plain prompt ".repeat(40) }])
  expect(seen.body.config.frozen_message_count).toBeUndefined()
  expect(got).toEqual({ model: "gpt-4o", input: "short" })
})

test("protect_cache false sends the whole transcript and still refuses a broken tool id", async () => {
  const messages = [
    { role: "user", content: "old" },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "big" }] },
  ]
  const seen = {}
  globalThis.fetch = answer({
    messages: [
      { role: "user", content: "old-compressed" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_OTHER", name: "read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "small" }] },
    ],
  }, seen)
  const body = { model: "claude-sonnet", messages }
  expect(await mod.onRequest(body, ctx({ options: { protect_cache: false } }))).toBeUndefined()
  expect(seen.body.config).toEqual({ compress_user_messages: true })
  expect(body.messages).toEqual(messages)
})

test("a rewritten thinking signature or a dropped image is not forwarded", async () => {
  const messages = [{ role: "user", content: "go" }, {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "plan", signature: "sig_1" },
      { type: "text", text: "answer" },
    ],
  }]
  globalThis.fetch = answer({
    messages: [messages[0], { role: "assistant", content: [{ type: "thinking", thinking: "plan", signature: "sig_2" }, { type: "text", text: "shorter" }] }],
  })
  expect(await mod.onRequest({ model: "m", messages }, ctx({ options: { protect_cache: false } }))).toBeUndefined()

  const withImage = [{ role: "user", content: [{ type: "text", text: "see" }, { type: "image", source: { type: "base64", data: "aaaa" } }] }]
  globalThis.fetch = answer({ messages: [{ role: "user", content: [{ type: "text", text: "see" }] }] })
  expect(await mod.onRequest({ model: "m", messages: withImage }, ctx({ options: { protect_cache: false } }))).toBeUndefined()
})

test("encrypted Responses content in the tail is kept byte for byte", async () => {
  const messages = [
    { role: "user", content: "go" },
    { type: "reasoning", encrypted_content: "cipher", summary: [] },
  ]
  globalThis.fetch = answer({ messages: [messages[0], { type: "reasoning", encrypted_content: "other", summary: [] }] })
  expect(await mod.onRequest({ model: "m", input: messages }, ctx({ protocol: "responses", options: { protect_cache: false } }))).toBeUndefined()
})

test("an unchanged tail keeps the original body", async () => {
  const messages = [{ role: "user", content: "cached", cache_control: { type: "ephemeral" } }, { role: "user", content: "same" }]
  globalThis.fetch = answer({ messages, tokens_saved: 0 })
  expect(await mod.onRequest({ model: "m", messages }, ctx())).toBeUndefined()
})

test("a prefix Headroom rewrote is discarded, tail included", async () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "cached", cache_control: { type: "ephemeral" } }] },
    { role: "user", content: "tail" },
  ]
  globalThis.fetch = answer({
    messages: [
      { role: "user", content: [{ type: "text", text: "CHANGED", cache_control: { type: "ephemeral" } }] },
      { role: "user", content: "short" },
    ],
  })
  const reported = []
  expect(await mod.onRequest({ model: "m", messages }, ctx({ report: (c) => reported.push(c) }))).toBeUndefined()
  expect(reported).toEqual(["invalid"])
})

test("failures and timeouts leave the original body", async () => {
  const body = { model: "m", stream: false, messages: [{ role: "user", content: "a" }, { role: "user", content: "tail ".repeat(30) }] }
  const reported = []
  const c = ctx({ report: (code) => reported.push(code) })
  globalThis.fetch = async () => { throw new Error("connect ECONNREFUSED") }
  expect(await mod.onRequest(body, c)).toBeUndefined()
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) })
  expect(await mod.onRequest(body, c)).toBeUndefined()
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new Error("not json") } })
  expect(await mod.onRequest(body, c)).toBeUndefined()
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ messages: body.messages.slice(0, 1) }) })
  expect(await mod.onRequest(body, c)).toBeUndefined()
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ messages: body.messages, compression_skipped: true, skip_reason: "compression_timeout" }) })
  expect(await mod.onRequest(body, c)).toBeUndefined()
  expect(body.messages[1].content.startsWith("tail")).toBe(true)
  expect(reported).toEqual(["unavailable", "unavailable", "invalid", "invalid"])
})

test("the fetch aborts on timeout and on the request signal", async () => {
  const body = { model: "m", messages: [{ role: "user", content: "a" }, { role: "user", content: "tail" }] }
  globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
    const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
    if (init.signal?.aborted) abort()
    else init.signal?.addEventListener("abort", abort)
  })
  const started = Date.now()
  expect(await mod.onRequest(body, ctx({ options: { timeout_ms: 80 } }))).toBeUndefined()
  expect(Date.now() - started).toBeLessThan(2000)

  const ctl = new AbortController()
  ctl.abort()
  expect(await mod.onRequest(body, ctx({ signal: ctl.signal, options: { timeout_ms: 5000 } }))).toBeUndefined()
})

test("url, token and a non-http url", async () => {
  const body = { model: "m", messages: [{ role: "user", content: "a" }, { role: "user", content: "tail" }] }
  const seen = {}
  globalThis.fetch = answer({ messages: [body.messages[0], { role: "user", content: "short" }] }, seen)
  await mod.onRequest(body, ctx({ options: { url: "http://127.0.0.1:9999/base/", token: "secret" } }))
  expect(seen.url).toBe("http://127.0.0.1:9999/base/v1/compress")
  expect(seen.headers["X-Headroom-Proxy-Token"]).toBe("secret")

  let called = false
  globalThis.fetch = () => { called = true }
  expect(await mod.onRequest(body, ctx({ options: { url: "ftp://127.0.0.1/headroom" } }))).toBeUndefined()
  expect(called).toBe(false)

  const seenBad = {}
  globalThis.fetch = answer({ messages: [body.messages[0], { role: "user", content: "short" }] }, seenBad)
  await mod.onRequest(body, ctx({ options: { url: "http://127.0.0.1:8787/v1/compress", token: "bad\r\n" } }))
  expect(seenBad.headers["X-Headroom-Proxy-Token"]).toBeUndefined()
})

test("a full compress url is not doubled, and ctx.model is not written onto the body", async () => {
  const seen = {}
  const messages = [{ role: "user", content: "tail" }]
  globalThis.fetch = answer({ messages: [{ role: "user", content: "short" }], tokens_saved: 999999 }, seen)
  const got = await mod.onRequest({ messages }, ctx({ model: "claude-sonnet", options: { url: "http://127.0.0.1:8787/v1/compress", protect_cache: false } }))
  expect(seen.url).toBe("http://127.0.0.1:8787/v1/compress")
  expect(seen.body.model).toBe("claude-sonnet")
  expect(got.model).toBeUndefined()
  expect(Object.keys(got)).toEqual(["messages"])
})

test("the middleware cases never call Headroom", async () => {
  const cases = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8"))
  for (const c of cases) {
    let called = false
    globalThis.fetch = () => { called = true; throw new Error("unexpected fetch for " + c.name) }
    const requestCtx = {
      protocol: "anthropic", model: "", stream: false, path: "", ...c.ctx,
      options: c.options ?? {}, state: {},
    }
    expect(await mod.onRequest(structuredClone(c.request), requestCtx)).toBeUndefined()
    expect(called).toBe(false)
  }
})

test("no model, a missing transcript and a weird body do not fetch", async () => {
  let called = false
  globalThis.fetch = () => { called = true }
  expect(await mod.onRequest({ messages: [{ role: "user", content: "x" }] }, ctx({ model: "" }))).toBeUndefined()
  expect(await mod.onRequest({ model: "m" }, ctx())).toBeUndefined()
  expect(await mod.onRequest(null, ctx())).toBeUndefined()
  expect(await mod.onRequest(["m"], ctx())).toBeUndefined()
  expect(called).toBe(false)
})
