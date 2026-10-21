// Compress an agent's request with a local Headroom, then hand the body
// back to magpie. Headroom's proxy would forward the request itself, which
// fights magpie's gateway, so this calls only POST /v1/compress: messages
// in, compressed messages out, no provider call and no API key.
//
// That endpoint is the path the TypeScript SDK and LiteLLM's guardrail use.
// The SDK is not used here: it rewrites everything into OpenAI chat and
// back, which drops Anthropic cache_control, thinking signatures and
// Responses item types. MCP headroom_compress shrinks one blob and expects
// a headroom_retrieve tool this hook is not allowed to add. Gateway mode
// compacts tool schemas and can ask for a second provider call; magpie
// rolls a hook back when tools, model or stream change, and onRequest
// returns a single body.
//
// Off until `agents` or `models` is set. Any error or timeout returns
// undefined, and magpie forwards the original request. The frozen prefix
// is copied from the request magpie handed us, so a later JSON encode keeps
// that prefix's key order.

const DEFAULT_URL = "http://127.0.0.1:8787"
const IMAGES = new Set(["image", "image_url", "input_image"])

export async function onRequest(body, ctx) {
  try {
    return await rewrite(body, ctx || {})
  } catch {
    tell(ctx, "unavailable")
  }
}

async function rewrite(body, ctx) {
  const o = plain(ctx.options) ? ctx.options : {}
  if (!plain(body)) return
  const model = typeof body.model === "string" && body.model ? body.model : typeof ctx.model === "string" ? ctx.model : ""
  if (!selected(o, ctx, model) || !model) return
  const found = transcript(body, ctx.protocol)
  if (!found) return
  const [key, messages, asString] = found
  if (!messages.length) return
  const protect = o.protect_cache !== false
  const frozen = frozenCount(messages, protect)
  if (frozen >= messages.length) return

  const url = endpoint(o.url)
  if (!url) return
  const payload = { messages, model, config: { compress_user_messages: true } }
  if (frozen > 0) payload.config.frozen_message_count = frozen
  const headers = { "content-type": "application/json" }
  if (typeof o.token === "string" && o.token && !/[\r\n]/.test(o.token)) headers["X-Headroom-Proxy-Token"] = o.token

  const res = await globalThis.fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: deadline(timeoutMs(o), ctx.signal),
    redirect: "error",
  })
  if (!res || !res.ok) return tell(ctx, "unavailable")
  let data
  try {
    data = await res.json()
  } catch {
    return tell(ctx, "invalid")
  }
  if (!plain(data) || !Array.isArray(data.messages)) return tell(ctx, "invalid")
  if (data.compression_skipped) return
  const compressed = data.messages
  if (compressed.length !== messages.length) return tell(ctx, "invalid")
  for (let i = 0; i < frozen; i++) if (!same(messages[i], compressed[i])) return tell(ctx, "invalid")
  for (let i = frozen; i < messages.length; i++) if (!intact(messages[i], compressed[i])) return tell(ctx, "invalid")

  const merged = messages.slice()
  let changed = false
  for (let i = frozen; i < merged.length; i++) {
    if (!same(messages[i], compressed[i])) changed = true
    merged[i] = compressed[i]
  }
  if (!changed) return
  const saved = Number.isFinite(data.tokens_saved) ? Math.max(0, Math.floor(data.tokens_saved)) : 0
  tell(ctx, "ready", saved)
  if (asString) {
    const only = merged[0]
    if (merged.length === 1 && only && only.role === "user" && typeof only.content === "string") return { ...body, input: only.content }
    return { ...body, input: merged }
  }
  return { ...body, [key]: merged }
}

// agents and models are an allowlist. With neither set, nothing is compressed.
function selected(o, ctx, model) {
  const agents = strings(o.agents)
  const models = strings(o.models)
  if (!agents.length && !models.length) return false
  if (agents.length && !agents.includes(ctx.agent)) return false
  if (models.length && !models.some((p) => String(model).startsWith(p))) return false
  return true
}

function strings(v) {
  return Array.isArray(v) ? v.filter((s) => typeof s === "string" && s) : []
}

// Anthropic and Chat keep their `messages`. Responses keeps `input`, which
// Headroom also compresses as a message list (its proxy treats Responses
// items, including function_call_output, as first-class). A string `input`
// is one user message on the way to Headroom and a string again on the way
// back when it still is one.
function transcript(body, protocol) {
  if (protocol === "anthropic" || protocol === "chat") {
    return Array.isArray(body.messages) ? ["messages", body.messages, false] : null
  }
  if (protocol === "responses") {
    if (Array.isArray(body.input)) return ["input", body.input, false]
    if (typeof body.input === "string") return ["input", [{ role: "user", content: body.input }], true]
  }
  return null
}

// The cache-stable prefix is not compressed. With Anthropic cache_control,
// that is every message up to and including the last breakpoint: bytes after
// it are the only ones a prefix cache will not already have. With no
// breakpoint (OpenAI's automatic cache has none), everything before the
// latest user turn is the prefix. protect_cache false freezes nothing.
function frozenCount(messages, protect) {
  if (!protect) return 0
  let last = -1
  for (let i = 0; i < messages.length; i++) if (marked(messages[i])) last = i
  if (last >= 0) return last + 1
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i] && messages[i].role === "user") return i
  return messages.length
}

function marked(message) {
  if (!plain(message)) return false
  if (plain(message.cache_control)) return true
  if (!Array.isArray(message.content)) return false
  return message.content.some((b) => plain(b) && plain(b.cache_control))
}

// Tool pairing, signed thinking and images have to survive compression.
// Text inside a tool result may change; the id it is paired with may not.
function intact(before, after) {
  if (!plain(before) || !plain(after)) return false
  if ((before.role ?? "") !== (after.role ?? "")) return false
  if ((before.type ?? "") !== (after.type ?? "")) return false
  if (anchors(before).join("\0") !== anchors(after).join("\0")) return false
  if (stable(sealed(before)) !== stable(sealed(after))) return false
  if (countImages(before) !== countImages(after)) return false
  return true
}

function anchors(message) {
  const out = []
  if (typeof message.tool_call_id === "string") out.push("tool_call_id:" + message.tool_call_id)
  if (typeof message.call_id === "string") out.push("call_id:" + message.call_id)
  if (Array.isArray(message.tool_calls)) {
    for (const t of message.tool_calls) if (plain(t) && typeof t.id === "string") out.push("tool_call:" + t.id)
  }
  const content = Array.isArray(message.content) ? message.content : []
  for (const b of content) {
    if (!plain(b)) continue
    if (typeof b.id === "string" && (b.type === "tool_use" || b.type === "tool_result" || b.type === "server_tool_use")) out.push(b.type + ":" + b.id)
    if (typeof b.tool_use_id === "string") out.push("tool_use_id:" + b.tool_use_id)
  }
  return out
}

function sealed(message) {
  const out = []
  if (typeof message.encrypted_content === "string") out.push(message.encrypted_content)
  const content = Array.isArray(message.content) ? message.content : []
  for (const b of content) if (plain(b) && (b.type === "thinking" || b.type === "redacted_thinking")) out.push(b)
  return out
}

function countImages(message) {
  let n = message.type && IMAGES.has(message.type) ? 1 : 0
  const content = Array.isArray(message.content) ? message.content : []
  for (const b of content) if (plain(b) && IMAGES.has(b.type)) n++
  return n
}

function endpoint(raw) {
  const base = typeof raw === "string" && raw ? raw : DEFAULT_URL
  let u
  try {
    u = new URL(base)
  } catch {
    return
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return
  const path = u.pathname.replace(/\/+$/, "")
  if (!path.endsWith("/v1/compress")) u.pathname = path + "/v1/compress"
  return u.href
}

function timeoutMs(o) {
  const n = o.timeout_ms
  if (typeof n !== "number" || !Number.isFinite(n)) return 1500
  return Math.min(10000, Math.max(100, Math.floor(n)))
}

function deadline(ms, outer) {
  const timer = AbortSignal.timeout(ms)
  return outer ? AbortSignal.any([outer, timer]) : timer
}

function tell(ctx, code, bytes) {
  try {
    if (ctx && typeof ctx.report === "function") ctx.report(code, bytes)
  } catch { /* a diagnostic must not change the request */ }
}

function plain(v) {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function same(a, b) {
  return stable(a) === stable(b)
}

function stable(v) {
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]"
  if (plain(v)) return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}"
  return JSON.stringify(v) ?? "null"
}
