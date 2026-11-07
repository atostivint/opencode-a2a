import { randomUUID } from "node:crypto"

export interface AgentCard {
  name: string
  description?: string
  url: string
  version?: string
  supportedInterfaces?: Array<{
    url: string
    protocolBinding: string
    protocolVersion?: string
  }>
  capabilities?: Record<string, unknown>
  defaultInputModes?: string[]
  defaultOutputModes?: string[]
  skills?: Array<{
    id: string
    name: string
    description?: string
    tags?: string[]
  }>
  securitySchemes?: Record<string, unknown>
  security?: unknown[]
}

export interface Part {
  kind?: string
  type?: string
  text?: string
  [key: string]: unknown
}

export interface Message {
  kind?: string
  role?: string
  messageId?: string
  contextId?: string
  taskId?: string
  parts?: Part[]
  [key: string]: unknown
}

export interface TaskStatus {
  state: string
  message?: Message
  timestamp?: string
}

export interface Artifact {
  artifactId?: string
  name?: string
  parts?: Part[]
  [key: string]: unknown
}

export interface Task {
  kind?: string
  id: string
  contextId?: string
  status: TaskStatus
  artifacts?: Artifact[]
  history?: Message[]
  [key: string]: unknown
}

export type SendResult =
  | {
      kind: "message"
      text: string
      contextId?: string
      message: Message
      raw: unknown
    }
  | {
      kind: "task"
      text: string
      task: Task
      contextId?: string
      raw: unknown
    }

export interface A2AClientOptions {
  baseURL: string
  token?: string
  auth?: "bearer" | "none"
  timeoutMs?: number
  pollIntervalMs?: number
  fetch?: typeof fetch
}

export interface SendOptions {
  contextId?: string
  taskId?: string
  wait?: boolean
  timeoutMs?: number
  pollIntervalMs?: number
}

const TERMINAL_STATES = new Set([
  "completed",
  "failed",
  "canceled",
  "cancelled",
  "rejected",
  "input-required",
  "auth-required",
])

export class A2AError extends Error {
  constructor(
    message: string,
    readonly code?: string | number,
    readonly status?: number,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = "A2AError"
  }
}

export class A2AClient {
  private cardValue?: AgentCard
  private endpointValue?: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly pollIntervalMs: number

  constructor(private readonly options: A2AClientOptions) {
    this.fetchImpl = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000
  }

  get baseURL(): string {
    return this.options.baseURL.replace(/\/+$/, "")
  }

  async card(): Promise<AgentCard> {
    if (this.cardValue) return this.cardValue

    const cardURL = this.baseURL.endsWith("agent-card.json")
      ? this.baseURL
      : `${this.baseURL}/.well-known/agent-card.json`

    let response: Response
    try {
      response = await this.fetchImpl(cardURL, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (cause) {
      throw new A2AError(`agent card request failed: ${messageOf(cause)}`, "agent_card_network")
    }

    if (!response.ok) {
      throw new A2AError(`agent card returned HTTP ${response.status}`, "agent_card_http", response.status)
    }

    let card: AgentCard
    try {
      card = (await response.json()) as AgentCard
    } catch (cause) {
      throw new A2AError(`agent card is not valid JSON: ${messageOf(cause)}`, "agent_card_json")
    }

    if (!card?.name) throw new A2AError("agent card has no name", "agent_card_invalid")

    this.cardValue = card
    const iface = card.supportedInterfaces?.find(
      (candidate) => candidate.protocolBinding?.toUpperCase() === "JSONRPC",
    )
    this.endpointValue = iface?.url ?? card.url ?? this.baseURL
    return card
  }

  async endpoint(): Promise<string> {
    await this.card()
    return this.endpointValue ?? this.baseURL
  }

  async send(text: string, options: SendOptions = {}): Promise<SendResult> {
    if (!text.trim()) throw new A2AError("message text is empty", "empty_message")

    const message: Message = {
      role: "user",
      messageId: randomUUID(),
      parts: [{ kind: "text", text }],
      ...(options.contextId ? { contextId: options.contextId } : {}),
      ...(options.taskId ? { taskId: options.taskId } : {}),
    }

    const raw = await this.rpc("message/send", { message }, options.timeoutMs)

    if (isTask(raw)) {
      const task = options.wait === false ? raw : await this.waitForTask(raw, options)
      return {
        kind: "task",
        text: textFromTask(task) || `Task ${task.id} finished with state ${task.status?.state ?? "unknown"}`,
        task,
        contextId: task.contextId,
        raw,
      }
    }

    if (isMessage(raw)) {
      return {
        kind: "message",
        text: textFromMessage(raw),
        contextId: raw.contextId,
        message: raw,
        raw,
      }
    }

    const fallback = textFromMessage(raw as Message)
    if (fallback) {
      return { kind: "message", text: fallback, message: raw as Message, raw }
    }

    throw new A2AError(`unexpected A2A result: ${preview(raw)}`, "bad_result")
  }

  async getTask(taskId: string, timeoutMs = this.timeoutMs): Promise<Task> {
    if (!taskId.trim()) throw new A2AError("task id is empty", "empty_task_id")
    const raw = await this.rpc("tasks/get", { id: taskId }, timeoutMs)
    if (!isTask(raw)) {
      throw new A2AError(`tasks/get did not return a task: ${preview(raw)}`, "bad_result")
    }
    return raw
  }

  async waitForTask(task: Task, options: SendOptions = {}): Promise<Task> {
    const deadline = Date.now() + (options.timeoutMs ?? this.timeoutMs)
    const interval = options.pollIntervalMs ?? this.pollIntervalMs
    let current = task

    while (true) {
      const state = current.status?.state
      if (state && TERMINAL_STATES.has(state)) return current
      if (Date.now() >= deadline) {
        throw new A2AError(
          `task ${current.id} timed out in state ${state ?? "unknown"}`,
          "task_timeout",
        )
      }
      await sleep(interval)
      current = await this.getTask(current.id, Math.max(1_000, deadline - Date.now()))
    }
  }

  private async rpc(method: string, params: unknown, timeoutMs = this.timeoutMs): Promise<unknown> {
    const endpoint = await this.endpoint()
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    }

    if ((this.options.auth ?? "bearer") === "bearer") {
      if (!this.options.token?.trim()) {
        throw new A2AError(
          "A2A token is missing; set IRIS_A2A_TOKEN or the plugin token option",
          "missing_token",
        )
      }
      headers.authorization = `Bearer ${this.options.token}`
    }

    const body = JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params })

    let response: Response
    try {
      response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (cause) {
      throw new A2AError(`A2A request failed: ${messageOf(cause)}`, "network")
    }

    const raw = await response.text()
    let json: any
    try {
      json = raw ? JSON.parse(raw) : {}
    } catch {
      throw new A2AError(
        `A2A returned non-JSON (HTTP ${response.status}): ${raw.slice(0, 200)}`,
        "bad_response",
        response.status,
      )
    }

    if (response.status === 401) {
      throw new A2AError(
        "A2A unauthorized; check the bearer token",
        json?.error?.code ?? "unauthorized",
        401,
        json?.error,
      )
    }

    if (json?.error) {
      throw new A2AError(
        json.error.message ?? "A2A JSON-RPC error",
        json.error.code,
        response.status,
        json.error.data,
      )
    }

    if (!response.ok) {
      throw new A2AError(`A2A HTTP ${response.status}`, "http", response.status, json)
    }

    return json?.result
  }
}

export function textFromParts(parts?: Part[]): string {
  if (!Array.isArray(parts)) return ""
  return parts
    .filter(
      (part) =>
        part &&
        (part.kind === "text" || part.type === "text") &&
        typeof part.text === "string",
    )
    .map((part) => part.text!.trim())
    .filter(Boolean)
    .join("\n")
}

export function textFromMessage(message?: Message | null): string {
  return textFromParts(message?.parts)
}

export function textFromTask(task: Task): string {
  const chunks: string[] = []
  const status = textFromMessage(task.status?.message)
  if (status) chunks.push(status)
  for (const artifact of task.artifacts ?? []) {
    const text = textFromParts(artifact.parts)
    if (text) chunks.push(text)
  }
  return chunks.join("\n\n").trim()
}

function isTask(value: unknown): value is Task {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as Task).id === "string" &&
    !!(value as Task).status &&
    typeof (value as Task).status.state === "string"
  )
}

function isMessage(value: unknown): value is Message {
  return !!value && typeof value === "object" && Array.isArray((value as Message).parts)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function preview(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 300)
  } catch {
    return String(value)
  }
}
