import { Plugin } from "@opencode/plugin"
import { A2AClient, A2AError, textFromTask } from "./a2a.js"

type AuthMode = "bearer" | "none"

interface AgentOptions {
  url: string
  token?: string
  tokenEnv?: string
  auth?: AuthMode
  description?: string
  timeoutMs?: number
  pollIntervalMs?: number
}

interface Options {
  agents?: Record<string, AgentOptions>
  defaultAgent?: string
  timeoutMs?: number
  pollIntervalMs?: number
  toolPrefix?: string
}

interface AgentRuntime {
  name: string
  description?: string
  client: A2AClient
}

function parseOptions(value: unknown): Options {
  if (!value || typeof value !== "object") return {}
  return value as Options
}

function resolveToken(agent: AgentOptions): string | undefined {
  if (agent.token?.trim()) return agent.token.trim()
  if (agent.tokenEnv) {
    const fromEnv = process.env[agent.tokenEnv]?.trim()
    if (fromEnv) return fromEnv
  }
  if ((agent.auth ?? "bearer") === "bearer") {
    return process.env.IRIS_A2A_TOKEN?.trim() ?? process.env.A2A_TOKEN?.trim()
  }
  return undefined
}

function makeAgents(options: Options): Map<string, AgentRuntime> {
  const configured = options.agents ?? {}
  const entries = Object.entries(configured)
  if (entries.length === 0) {
    throw new Error("opencode-a2a: configure at least one agent under options.agents")
  }

  const agents = new Map<string, AgentRuntime>()
  for (const [name, agent] of entries) {
    if (!agent?.url) throw new Error(`opencode-a2a: agent "${name}" is missing url`)
    agents.set(name, {
      name,
      description: agent.description,
      client: new A2AClient({
        baseURL: agent.url,
        token: resolveToken(agent),
        auth: agent.auth ?? "bearer",
        timeoutMs: agent.timeoutMs ?? options.timeoutMs,
        pollIntervalMs: agent.pollIntervalMs ?? options.pollIntervalMs,
      }),
    })
  }
  return agents
}

function pickAgent(
  agents: Map<string, AgentRuntime>,
  requested: string | undefined,
  fallback: string | undefined,
): AgentRuntime {
  const name = requested?.trim() || fallback?.trim() || agents.keys().next().value
  if (!name) throw new Error("opencode-a2a: no agent configured")
  const agent = agents.get(name)
  if (!agent) {
    throw new Error(
      `opencode-a2a: unknown agent "${name}"; configured: ${[...agents.keys()].join(", ")}`,
    )
  }
  return agent
}

function asError(cause: unknown): Error {
  if (cause instanceof A2AError) {
    const code = cause.code === undefined ? "" : ` [${cause.code}]`
    return new Error(`A2A error${code}: ${cause.message}`)
  }
  return cause instanceof Error ? cause : new Error(String(cause))
}

export default Plugin.define({
  id: "opencode-a2a",
  async setup(ctx) {
    const options = parseOptions(ctx.options)
    const agents = makeAgents(options)
    const prefix = (options.toolPrefix ?? "a2a").replace(/[^a-zA-Z0-9_]/g, "_")
    const defaultAgent = options.defaultAgent

    await ctx.tool.transform((editor) => {
      editor.add({
        name: `${prefix}_agents`,
        description:
          "List the A2A agents configured for this OpenCode session, including their advertised skills.",
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          const lines: string[] = []
          for (const agent of agents.values()) {
            try {
              const card = await agent.client.card()
              const skills = (card.skills ?? [])
                .slice(0, 12)
                .map((skill) => skill.name || skill.id)
                .join(", ")
              lines.push(
                `${agent.name}: ${card.name}${card.description ? ` — ${card.description}` : ""}`,
              )
              if (skills) lines.push(`  skills: ${skills}`)
              if (agent.description) lines.push(`  note: ${agent.description}`)
            } catch (cause) {
              lines.push(`${agent.name}: unavailable (${asError(cause).message})`)
            }
          }
          return { content: lines.join("\n") }
        },
      })

      editor.add({
        name: `${prefix}_send`,
        description:
          "Send a text message to an A2A agent (Iris/Hermes by default) and return its reply. Long-running tasks are polled until they finish.",
        input: {
          type: "object",
          properties: {
            agent: {
              type: "string",
              description: "Configured agent name. Defaults to the plugin's defaultAgent.",
            },
            text: { type: "string", description: "Message to send." },
            contextId: {
              type: "string",
              description: "Optional A2A context id to continue a conversation.",
            },
            taskId: {
              type: "string",
              description: "Optional task id when replying to an input-required task.",
            },
            wait: {
              type: "boolean",
              description: "Wait for task completion. Defaults to true.",
            },
            timeoutMs: { type: "number", description: "Timeout in milliseconds." },
          },
          required: ["text"],
          additionalProperties: false,
        },
        async execute(raw) {
          const input = raw as {
            agent?: string
            text: string
            contextId?: string
            taskId?: string
            wait?: boolean
            timeoutMs?: number
          }
          const agent = pickAgent(agents, input.agent, defaultAgent)
          try {
            const result = await agent.client.send(input.text, {
              contextId: input.contextId,
              taskId: input.taskId,
              wait: input.wait,
              timeoutMs: input.timeoutMs,
            })
            return {
              content: result.text || "(no text returned)",
              metadata: {
                agent: agent.name,
                kind: result.kind,
                contextId: result.contextId,
                taskId: result.kind === "task" ? result.task.id : undefined,
                state: result.kind === "task" ? result.task.status?.state : undefined,
              },
            }
          } catch (cause) {
            throw asError(cause)
          }
        },
      })

      editor.add({
        name: `${prefix}_task`,
        description: "Fetch the current state and output of an A2A task by id.",
        input: {
          type: "object",
          properties: {
            agent: { type: "string", description: "Configured agent name." },
            taskId: { type: "string", description: "Task id returned by a2a_send." },
            timeoutMs: { type: "number" },
          },
          required: ["taskId"],
          additionalProperties: false,
        },
        async execute(raw) {
          const input = raw as { agent?: string; taskId: string; timeoutMs?: number }
          const agent = pickAgent(agents, input.agent, defaultAgent)
          try {
            const task = await agent.client.getTask(input.taskId, input.timeoutMs)
            return {
              content:
                textFromTask(task) ||
                `Task ${task.id} is in state ${task.status?.state ?? "unknown"}`,
              metadata: {
                agent: agent.name,
                taskId: task.id,
                contextId: task.contextId,
                state: task.status?.state,
              },
            }
          } catch (cause) {
            throw asError(cause)
          }
        },
      })
    })
  },
})
