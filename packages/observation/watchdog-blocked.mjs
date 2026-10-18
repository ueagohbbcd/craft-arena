// Runs in the watchdog's worker thread while the program's main thread is
// blocked, so the urgent report still reaches the inbox.
import { InboxClient } from "../inbox/index.mjs";

export default async function onBlocked(event, connection) {
  await new InboxClient(connection).requestJudgment({
    watchdog: event.type,
    ...event,
  });
}
