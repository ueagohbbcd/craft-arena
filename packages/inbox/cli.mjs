#!/usr/bin/env node
import { InboxClient } from "./ipc.mjs";
const [action, ...args] = process.argv.slice(2);
try {
  const client = new InboxClient();
  let result;
  if (action === "post") result = await client.post(JSON.parse(args.join(" ")));
  else if (action === "upsert")
    result = await client.upsert(args[0], JSON.parse(args.slice(1).join(" ")));
  else if (action === "status")
    result = await client.setStatus(
      args[0],
      JSON.parse(args.slice(1).join(" ")),
    );
  else if (action === "urgent")
    result = await client.requestJudgment(JSON.parse(args.join(" ")));
  else
    throw new Error(
      "Usage: inbox post JSON | inbox upsert KEY JSON | inbox status KEY JSON | inbox urgent JSON",
    );
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
