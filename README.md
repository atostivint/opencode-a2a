# opencode-a2a

OpenCode V2 plugin that talks to [A2A](https://a2a-protocol.org/) agents over
JSON-RPC 2.0. It adds tools for sending messages, polling tasks, and listing
configured agents.

Built for talking to **Iris** (Hermes Agent) over Tailscale, but works with any
A2A 1.0 agent that exposes a JSONRPC interface.

## Tools

| Tool | What it does |
| --- | --- |
| `a2a_send` | Send text to an agent, wait for a `message` or `task`, poll long tasks, return the text reply |
| `a2a_task` | Fetch the current state and output of a task by id |
| `a2a_agents` | List configured agents and their advertised skills |

## Install

```sh
cd opencode-a2a
bun install
bun run typecheck
bun test
```

Add the plugin to `~/.config/opencode/opencode.json`:

```json
{
  "plugins": [
    {
      "package": "C:/Users/elekt/Projets/opencode-a2a",
      "options": {
        "defaultAgent": "iris",
        "agents": {
          "iris": {
            "url": "http://100.119.105.2:9900/",
            "token": "{file:~/.config/opencode/secrets/iris-a2a-token}"
          }
        }
      }
    }
  ]
}
```

The token can also come from an environment variable:

```json
{
  "url": "http://100.119.105.2:9900/",
  "token": "{env:IRIS_A2A_TOKEN}"
}
```

`{file:...}` and `{env:...}` are resolved by OpenCode before the plugin sees its
options. Do not commit a token. `.gitignore` already excludes `.env`, `*.key`,
and `secrets/`.

## Agent card

The plugin discovers the card at:

```text
<url>/.well-known/agent-card.json
```

It uses the first `supportedInterfaces` entry whose `protocolBinding` is
`JSONRPC`, falling back to the card's `url`. Bearer auth is sent as
`Authorization: Bearer <token>`. Set `"auth": "none"` for an open agent.

## Development

```sh
# Live probe against Iris (expects 401 without a token)
bun run scripts/probe.ts "ping"

# With a token
IRIS_A2A_TOKEN="..." bun run scripts/probe.ts "ping"
```

## Limitations (0.1.0)

- Text parts only. File, audio, and video parts are ignored.
- No `message/stream` yet. Long tasks are polled with `tasks/get`.
- No push notification configuration.
- `tasks/get` uses the standard `{ "id": taskId }` params.

## License

MIT
