/** IPC-only teaching example. No game actions; delays simulate an ordinary program. */
import { setTimeout as sleep } from "node:timers/promises";
import { InboxClient } from "../packages/inbox/index.mjs";
const inbox = new InboxClient();
for (let done = 1; done <= 3; done++) {
  await inbox.upsert("demo.progress", { done, total: 5 }, { ttlMs: 30000 });
  await sleep(100);
}
await inbox.requestJudgment({
  reason: "Teaching demo requests an early decision",
  done: 3,
  total: 5,
  process: "still running",
});
// This process survives the tool's early return. It is not restarted to finish.
await sleep(1500);
await inbox.upsert("demo.progress", { done: 5, total: 5 }, { ttlMs: 30000 });
console.log(JSON.stringify({ demo: "complete", done: 5 }));
