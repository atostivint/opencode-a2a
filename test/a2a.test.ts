import { describe, expect, test } from "bun:test"
import { A2AClient, A2AError, textFromTask } from "../src/a2a.js"

const card = {
  name: "Iris",
  description: "Hermes Agent - a general-purpose agent reachable over A2A.",
  url: "http://agent/",
  supportedInterfaces: [
    {
      url: "http://agent/",
      protocolBinding: "JSONRPC",
      protocolVersion: "1.0",
    },
  ],
  capabilities: { streaming: true, pushNotifications: true },
  skills: [{ id: "toolset.a2a", name: "a2a", tags: ["a2a"] }],
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("A2AClient", () => {
  test("discovers the agent card and sends a message", async () => {
    const calls: string[] = []
    const fetchImpl = (async (input: any, init?: any) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith("/.well-known/agent-card.json")) return json(card)
      const body = JSON.parse(String(init?.body))
      expect(body.method).toBe("message/send")
      expect(init?.headers?.authorization).toBe("Bearer secret")
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          kind: "message",
          role: "agent",
          messageId: "m2",
          parts: [{ kind: "text", text: "pong" }],
        },
      })
    }) as typeof fetch

    const client = new A2AClient({ baseURL: "http://agent/", token: "secret", fetch: fetchImpl })
    const result = await client.send("ping")

    expect(result.kind).toBe("message")
    expect(result.text).toBe("pong")
    expect(calls).toContain("http://agent/.well-known/agent-card.json")
  })

  test("polls a task until completion", async () => {
    let polls = 0
    const fetchImpl = (async (input: any, init?: any) => {
      const url = String(input)
      if (url.endsWith("/.well-known/agent-card.json")) return json(card)
      const body = JSON.parse(String(init?.body))
      if (body.method === "message/send") {
        return json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            kind: "task",
            id: "t1",
            contextId: "c1",
            status: { state: "working" },
          },
        })
      }
      if (body.method === "tasks/get") {
        polls += 1
        return json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            kind: "task",
            id: "t1",
            contextId: "c1",
            status: { state: polls >= 2 ? "completed" : "working" },
            artifacts:
              polls >= 2 ? [{ parts: [{ kind: "text", text: "done" }] }] : [],
          },
        })
      }
      throw new Error(`unexpected ${body.method}`)
    }) as typeof fetch

    const client = new A2AClient({
      baseURL: "http://agent",
      token: "secret",
      fetch: fetchImpl,
      pollIntervalMs: 1,
    })
    const result = await client.send("do work")

    expect(result.kind).toBe("task")
    expect(result.text).toBe("done")
    expect(polls).toBe(2)
  })

  test("surfaces a 401 as a clear error", async () => {
    const fetchImpl = (async (input: any) => {
      const url = String(input)
      if (url.endsWith("/.well-known/agent-card.json")) return json(card)
      return json(
        { jsonrpc: "2.0", id: null, error: { code: -32050, message: "unauthorized" } },
        401,
      )
    }) as typeof fetch

    const client = new A2AClient({ baseURL: "http://agent", token: "bad", fetch: fetchImpl })
    await expect(client.send("ping")).rejects.toBeInstanceOf(A2AError)
    await expect(client.send("ping")).rejects.toThrow("unauthorized")
  })

  test("extracts task text from status and artifacts", () => {
    const task = {
      id: "t",
      status: {
        state: "completed",
        message: { parts: [{ kind: "text", text: "status" }] },
      },
      artifacts: [{ parts: [{ kind: "text", text: "artifact" }] }],
    }
    expect(textFromTask(task)).toBe("status\n\nartifact")
  })
})
