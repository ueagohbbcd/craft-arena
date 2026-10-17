import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInboxServer } from "../../packages/inbox/index.mjs";

/** An inbox server on a Unix socket in a temporary directory, closed after the test. */
export async function socketInbox(t, inbox, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "inbox-"));
  const socketPath = join(dir, "inbox.sock");
  const server = await createInboxServer({ inbox, socketPath, ...options });
  t.after(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { server, socketPath };
}
