# @magpie-community/middleware-headroom

Compresses what agents send, with a local [Headroom](https://github.com/headroomlabs-ai/headroom), before [magpie](https://usemagpie.ai) routes the request. It is an async gateway Request hook (`onRequest`): Headroom only compresses, and magpie still forwards the body. Headroom is not placed in front of the agent, and it is not added as a custom provider, so it does not take over magpie's routing.

This is the shape suggested on [magpie#769](https://github.com/yetone/magpie/issues/769). A compression layer inside the gateway was turned down because rewriting history drops provider prompt caches and makes an agent's tool results hard to reason about. A hook can do it for the agents you name, and step aside when it fails.

It calls Headroom's [`POST /v1/compress`](https://docs.headroomlabs.ai/docs/proxy#post-v1compress). That route returns compressed messages and does not call a model. It is the same call the TypeScript SDK and LiteLLM's Headroom guardrail make, and it accepts Anthropic and OpenAI message shapes as they are. The other ways to reach Headroom fit this hook less well:

- **The proxy.** Agents point their base URL at Headroom, and Headroom forwards upstream. That either bypasses magpie or makes Headroom and magpie both gateways.
- **The `headroom-ai` SDK.** It turns every transcript into OpenAI chat messages and back. Anthropic `cache_control`, thinking signatures and Responses items do not survive that round trip. The SDK is that HTTP call plus the conversion, so the hook makes the HTTP call itself.
- **MCP `headroom_compress`.** It compresses one blob of text and returns a hash for `headroom_retrieve`. The hook is not allowed to add that tool, and a marker the model cannot resolve is the behavior magpie#769 wanted to avoid.
- **Gateway mode** (`"gateway": {}` on `/v1/compress`). It can compact tool schemas, which is often where the tokens are, and it can ask the caller to send the provider's reply back and call the model again. magpie rolls a Request hook back when `tools`, `model` or `stream` change, and the hook returns one body. Those savings are left on the table on purpose.

`system`, `tools` and Responses `instructions` are not sent as something Headroom may replace. Only `messages` (Anthropic and Chat) or `input` (Responses) can change, and only when the result still pairs tool calls with their results.

Install it from magpie's **Plugins › Discover**, or with `magpie plugin add @magpie-community/middleware-headroom`. Set its options under **Plugins › Installed › Options**, or with `magpie plugin options headroom '<json>'`. Nothing is compressed until `agents` or `models` is set.

Needs magpie **0.1.1273** or later (the Request hook).

## Run Headroom

Headroom is a local Python program. The hook does not install or start it.

```sh
pip install "headroom-ai[proxy]"
headroom proxy --port 8787
```

The default listen address is `127.0.0.1:8787`. `POST /v1/compress` answers non-loopback callers with **404** unless you set `HEADROOM_COMPRESS_ALLOW_REMOTE=1` (the client address and the `Host` header both have to be loopback). Set `HEADROOM_PROXY_TOKEN` on Headroom and the same value as `token` here when it is reachable beyond your own machine. A first request can be slow while the compression model loads; that request is sent unchanged, and a later one compresses.

## Options

```json
{ "url": "http://127.0.0.1:8787",
  "token": "",
  "agents": ["claude"],
  "models": [],
  "timeout_ms": 1500,
  "gatewayTimeoutMs": 2500,
  "protect_cache": true }
```

- **`url`.** Headroom's base URL. The hook posts to `<url>/v1/compress`. Default `http://127.0.0.1:8787`. `http` and `https` only.
- **`token`.** Sent as `X-Headroom-Proxy-Token` when Headroom was started with `HEADROOM_PROXY_TOKEN`. Leave it empty on a loopback proxy with no token.
- **`agents`.** magpie agent ids this applies to (`claude`, `codex`, `opencode`, …). Empty means no agent filter.
- **`models`.** Model-name prefixes (`claude` matches `claude-sonnet-4-5`). Empty means no model filter.
- **Allowlist.** With both lists empty, the hook does nothing. When a list is non-empty, the request has to match it. Set both and it has to match both.
- **`timeout_ms`.** How long the hook waits for Headroom, in milliseconds, from 100 to 10000. Default 1500.
- **`gatewayTimeoutMs`.** magpie's own budget for this hook, from 100 to 10000, defaulting to 1000 when unset (the whole hook chain is capped at 10 seconds). Keep it above `timeout_ms`, or magpie aborts the hook first. The example uses 2500 and 1500.
- **`protect_cache`.** Default `true`. Compress only after the cache-stable prefix. See below.

Anthropic and Chat use `messages`. Responses uses `input` (a string input is compressed as one user message and written back as a string when it still is one). Gemini is left alone. `model` and `stream` are never changed. A result that drops or renames a tool id, edits a thinking signature, edits `encrypted_content`, or drops an image is thrown away.

## Cache

Providers cache a stable prefix of the request. Change a byte in that prefix and the rest of the conversation is billed as new input. magpie#769 is right that this can cost more than compression saves, and Claude Code and Codex already compact on their own.

With `protect_cache` left on:

- If any message carries Anthropic `cache_control`, every message up to and including that last breakpoint is sent back unchanged. Headroom is told the same thing (`config.frozen_message_count`) and, if it rewrites the prefix anyway, the hook ignores the reply.
- If nothing is marked, everything before the latest user turn is the prefix. OpenAI's automatic cache has no marker to read, so this is only a guess about what was already cached.
- The prefix messages in the body handed back are the objects from the original request, so their field order survives magpie re-encoding the JSON.

The tail is what gets smaller: a tool result that arrived after the breakpoint, or the newest user turn when there is no breakpoint. The agent sends its own original history again next turn. The hook does not remember what it forwarded, so a tail compressed this turn is original text again next turn, once the agent has folded it into the prefix. Savings are the uncached tail, and the marked prefix can still hit.

Two consequences:

- A request whose last message is itself the cache breakpoint has nothing after the prefix. The hook does not call Headroom. That is common when an agent pins `cache_control` on the latest block. Turn `protect_cache` off to compress that transcript, knowing the prefix cache will miss.
- Turning it off compresses the whole `messages` / `input` list on every request. Headroom's default `/v1/compress` pipeline is marker-free (no `<<ccr:…>>` pointers), so the provider can read the result without a retrieve tool. The bytes still change, and a prefix cache usually misses. User text is included (`compress_user_messages`); tool ids are not rewritten.

`protect_cache` does not keep a *compressed* prefix stable across turns. Headroom can do that itself with `config.session_id` (resend the raw transcript, get the same compressed prefix back). This hook does not turn that on: a session timeout is a 503 rather than Headroom's usual fail-open, the memory lives in one Headroom process, and forwarding the original body after a failure would desynchronize it.

## Fail open

A refused connection, a 404 from the loopback check, a 401, a timeout, a short or mismatched message list, or a result that breaks tool pairing: the hook returns nothing and magpie forwards the request it already had. The hook does not turn a request away.

## 中文

本插件把本机的 [Headroom](https://github.com/headroomlabs-ai/headroom) 接到 magpie 的异步 Request hook 上。它只调用 Headroom 的 `POST /v1/compress` 做压缩，压缩后的请求仍由 magpie 转发，Headroom 不充当代理，因此不会和 magpie 的路由、鉴权抢在一起。

Headroom 需要自己安装并启动（插件不会代为启动）。默认监听 `127.0.0.1:8787`：

```sh
pip install "headroom-ai[proxy]"
headroom proxy --port 8787
```

压缩接口默认只接受本机访问。magpie 与 Headroom 不在同一台机器上时，要在 Headroom 上设置 `HEADROOM_COMPRESS_ALLOW_REMOTE=1`；若设置了 `HEADROOM_PROXY_TOKEN`，把同一个值填进插件的 `token`。

在 magpie 0.1.1273 及以后安装。装上之后默认不压缩，配了 `agents` 或 `models` 才生效：

```sh
magpie plugin add @magpie-community/middleware-headroom
magpie plugin options headroom '{"url":"http://127.0.0.1:8787","agents":["claude"],"protect_cache":true,"timeout_ms":1500,"gatewayTimeoutMs":2500}'
```

缓存取舍：各家按前缀命中 prompt cache，前缀里改一个字节，后面的对话都会重新计费，省下的 token 往往抵不上这笔损失。`protect_cache` 默认为 true，只压缩缓存稳定前缀之后的内容：消息里有 Anthropic 的 `cache_control` 时，最后一个断点及其之前的消息保持原样；没有断点时（OpenAI 自动缓存没有标记），保留最近一条 user 消息之前的历史。这样已经缓存的前缀仍可能命中，但省下来的通常只是最新一轮。如果最后一条消息自己就是断点，前缀之后没有内容，插件不会压缩。把它设为 false 会压缩整段对话，省得更多，也更容易让前缀缓存失效。连接失败、超时或压缩结果对不上工具调用时，请求按原样发出。
