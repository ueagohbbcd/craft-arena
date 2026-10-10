import { StringDecoder } from "node:string_decoder";

/** Observe bounded JSONL without consuming or rewriting the child's log stream. */
export function observeRpcOutput(
  stream,
  receive,
  maxLineBytes = 16 * 1024 * 1024,
) {
  const decoder = new StringDecoder("utf8");
  let pending = "",
    dropping = false;
  const data = (chunk) => {
    pending += decoder.write(chunk);
    let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (!dropping && Buffer.byteLength(line) <= maxLineBytes) {
        let value;
        try {
          value = JSON.parse(line);
        } catch {
          /* Ordinary non-RPC log lines remain visible. */
        }
        if (
          value &&
          typeof value === "object" &&
          typeof value.type === "string"
        ) {
          try {
            receive(value);
          } catch {
            /* Malformed/non-RPC JSON logs cannot stop the resident. */
          }
        }
      }
      dropping = false;
    }
    if (Buffer.byteLength(pending) > maxLineBytes) {
      pending = "";
      dropping = true;
    }
  };
  stream.on("data", data);
  return () => stream.off("data", data);
}

export function permanentResidentError(message = "") {
  return /\b(?:400|401|403|404)\b|unauthori[sz]ed|invalid (?:api.?key|model|request|output|context)|unsupported|not configured|no (?:api key|model)|missing .*key|authentication|insufficient_quota|budget.*exhaust|exceeds (?:maximum budget|configured|the whole window)|request exceeds maximum|context[_ ]length[_ ]exceeded|context overflow|maximum context|prompt.*too long/i.test(
    message,
  );
}

const continueMessage = (reason) =>
  `${reason === "length" ? "The previous response reached the output limit. Continue concisely from the saved state and choose the next executable step." : "The previous model request failed. Recheck the current state and continue the match objective."} Existing tools or background programs may still be running: inspect their task IDs, use task_wait or observations as appropriate, and do not restart or repeat actions already submitted. Preserve successful work; do not assume an action failed merely because the model response ended.`;

/** Recover failed/truncated requests only. Ordinary decision scheduling belongs to the extension. */
export function createResidentRecovery({
  send,
  getMatchState,
  report = () => {},
  now = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
  checkDelayMs = 2000,
  retryDelayMs = 2000,
  maxRetries = 3,
  stateTimeoutMs = 3000,
}) {
  let closed = false,
    active = false,
    settled = false,
    generation = 0,
    timer,
    recovering = false;
  let endMessage,
    plan,
    errors = 0,
    emptyLengths = 0,
    sequence = 0;
  const states = new Map();
  const clear = () => {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
  };
  const arm = (delay) => {
    clear();
    if (!closed && plan)
      timer = schedule(() => {
        timer = undefined;
        void recover();
      }, delay);
  };
  const block = (reason) => {
    plan = undefined;
    clear();
    report(
      `Arena resident recovery blocked: ${reason}. Background tasks remain running; operator action or a new successful turn is required.`,
    );
  };
  const prepare = (message) => {
    const reason = message?.stopReason ?? "stop";
    if (reason !== "error" && reason !== "length") {
      errors = 0;
      emptyLengths = 0;
      plan = undefined;
      clear();
      return;
    }
    if (reason === "error") {
      if (permanentResidentError(message.errorMessage)) {
        block("permanent model configuration/authentication failure");
        return;
      }
      if (++errors > maxRetries) {
        block(`model request failed after ${maxRetries} recovery attempts`);
        return;
      }
      plan = {
        reason,
        delay: Math.min(60000, retryDelayMs * 2 ** (errors - 1)),
      };
    } else {
      errors = 0;
      const progress =
        Array.isArray(message?.content) &&
        message.content.some(
          (block) =>
            block.type === "toolCall" ||
            (block.type === "text" &&
              typeof block.text === "string" &&
              block.text.trim()),
        );
      if (reason === "length" && !progress) {
        if (++emptyLengths > maxRetries) {
          block(
            `empty output-limit responses persisted after ${maxRetries} recovery attempts`,
          );
          return;
        }
      } else emptyLengths = 0;
      plan = { reason, delay: checkDelayMs };
    }
    arm(plan.delay);
  };
  const state = () =>
    new Promise((resolve, reject) => {
      const id = `arena-recovery-state-${++sequence}`;
      const timeout = schedule(() => {
        states.delete(id);
        reject(new Error("RPC state timeout"));
      }, stateTimeoutMs);
      states.set(id, { resolve, reject, timeout });
      send({ id, type: "get_state" });
    });
  async function recover() {
    if (closed || active || !plan) return;
    if (recovering) {
      arm(checkDelayMs);
      return;
    }
    const version = generation,
      pending = plan;
    recovering = true;
    try {
      const match = await getMatchState();
      if (closed || version !== generation || active || plan !== pending)
        return;
      if (match !== "running") {
        if (match !== "ended") arm(checkDelayMs);
        return;
      }
      const status = await state();
      if (closed || version !== generation || active || plan !== pending)
        return;
      if (
        status.isStreaming ||
        status.isCompacting ||
        status.pendingMessageCount > 0
      ) {
        arm(checkDelayMs);
        return;
      }
      plan = undefined;
      active = true; // Hold the slot until prompt preflight or actual agent activity settles.
      report(
        `Arena resident recovery: continuing ${pending.reason} at ${now()}.`,
      );
      send({
        id: `arena-recovery-prompt-${++sequence}`,
        type: "prompt",
        message: continueMessage(pending.reason),
      });
    } catch {
      if (!closed && version === generation && plan === pending)
        arm(checkDelayMs);
    } finally {
      recovering = false;
    }
  }
  return {
    receive(event) {
      if (closed) return;
      if (event.type === "response" && states.has(event.id)) {
        const request = states.get(event.id);
        states.delete(event.id);
        cancel(request.timeout);
        if (event.success) request.resolve(event.data);
        else request.reject(new Error("RPC state rejected"));
        return;
      }
      if (event.type === "agent_start") {
        generation++;
        active = true;
        settled = false;
        endMessage = undefined;
        plan = undefined;
        clear();
      } else if (
        event.type === "message_end" &&
        event.message?.role === "assistant"
      )
        endMessage = event.message;
      else if (event.type === "agent_end")
        endMessage =
          (Array.isArray(event.messages)
            ? event.messages.findLast((message) => message.role === "assistant")
            : undefined) ?? endMessage;
      else if (event.type === "agent_settled") {
        if (settled && !active) return;
        settled = true;
        generation++;
        active = false;
        if (event.aborted) {
          plan = undefined;
          clear();
        } else prepare(endMessage);
      } else if (
        event.type === "response" &&
        event.command === "prompt" &&
        event.success &&
        event.data?.disposition === "handled"
      ) {
        active = false;
        prepare({ stopReason: "stop" });
      } else if (
        event.type === "response" &&
        event.command === "prompt" &&
        event.success === false
      ) {
        active = false;
        if (
          /already (?:processing|streaming)|currently streaming/i.test(
            event.error ?? "",
          )
        )
          return;
        prepare({ stopReason: "error", errorMessage: event.error });
      }
    },
    close() {
      closed = true;
      clear();
      for (const request of states.values()) {
        cancel(request.timeout);
        request.reject(new Error("Resident stopped"));
      }
      states.clear();
    },
  };
}
