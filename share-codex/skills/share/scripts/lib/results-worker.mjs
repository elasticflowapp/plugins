// The worker `bounded` (results.mjs) runs: one call of a function that reads
// pages with regular expressions, in a thread that can be ended when it takes
// too long. The same file in the Codex and the Antigravity client.
import { parentPort, workerData } from "node:worker_threads"
import { describeResult, verifyChosen } from "./results.mjs"

const tasks = { describeResult, verifyChosen }
try {
  const task = tasks[workerData.task]
  if (!task) throw new Error(`no such task: ${workerData.task}`)
  parentPort.postMessage({ ok: true, value: task(workerData.args) })
} catch (e) {
  parentPort.postMessage({ ok: false, error: e?.message ?? String(e) })
}
