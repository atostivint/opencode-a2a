import { A2AClient, A2AError } from "../src/a2a.js"

const url = process.env.A2A_URL ?? "http://127.0.0.1:9900/"
const token = process.env.IRIS_A2A_TOKEN
const client = new A2AClient({
  baseURL: url,
  token,
  auth: token ? "bearer" : "none",
  timeoutMs: 60_000,
})

try {
  const card = await client.card()
  console.log(`agent: ${card.name}`)
  console.log(`description: ${card.description ?? ""}`)
  console.log(`endpoint: ${await client.endpoint()}`)
  console.log(`skills: ${(card.skills ?? []).length}`)
  console.log(`auth: ${token ? "bearer" : "none"}`)

  const text = process.argv.slice(2).join(" ") || "ping"
  const result = await client.send(text, { wait: true, timeoutMs: 60_000 })
  console.log(`kind: ${result.kind}`)
  console.log(result.text)
} catch (cause) {
  if (cause instanceof A2AError) {
    console.error(`A2A ${cause.code ?? ""}: ${cause.message}`)
    process.exitCode = 2
  } else {
    throw cause
  }
}
