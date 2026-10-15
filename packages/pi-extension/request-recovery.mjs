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
            /* Malformed/non-RPC JSON logs cannot stop the session. */
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

export function isPermanentRequestError(message = "") {
  // Status numbers and words such as "unsupported" in arbitrary provider text
  // are not a diagnosis. In particular, a host end can reject a request with 403.
  return /invalid api[ _-]?key|incorrect api[ _-]?key|api[ _-]?key (?:is )?(?:missing|not configured)|no api key|missing api key|insufficient_quota|(?:token|cash|model) budget exhausted|request exceeds maximum budget|model is not allowed|no model (?:selected|configured)|context[_ ]length[_ ]exceeded|context overflow|prompt (?:is )?too long/i.test(
    message,
  );
}

const continueMessage = (reason) =>
  `${reason === "length" ? "The previous response reached the output limit. Continue concisely from the saved state and choose the next executable step." : "The previous model request failed. Recheck the current state and continue with what the session briefing asks of you."} Existing tools or background programs may still be running: inspect their task IDs (arena-task list), wait on them with bash taskId or check observations as appropriate, and do not restart or repeat actions already submitted. Preserve successful work; do not assume an action failed merely because the model response ended.`;

/** Recover failed/truncated requests only. Ordinary decision scheduling belongs to the extension. */
export function createRequestRecovery({
  send,
  getMatchState,
  report = () => {},
  onFatal = () => {},
  now = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
  checkDelayMs = 2000,
  retryDelayMs = 2000,
  maxRetryDelayMs = 60000,
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
  const backoff = (attempt) =>
    Math.min(maxRetryDelayMs, retryDelayMs * 2 ** Math.min(attempt - 1, 30));
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
      if (isPermanentRequestError(message.errorMessage)) {
        // Verify the trusted host is still running before failing the runtime.
        plan = { reason: "fatal", delay: checkDelayMs };
        arm(plan.delay);
        return;
      }
      errors = Math.min(errors + 1, 31);
      emptyLengths = 0;
      plan = {
        reason,
        delay: backoff(errors),
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
      emptyLengths = progress ? 0 : Math.min(emptyLengths + 1, 31);
      plan = {
        reason,
        delay: progress ? checkDelayMs : backoff(emptyLengths),
      };
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
      if (pending.reason === "fatal") {
        const failure = { type: "model-configuration", at: now() };
        report(
          "Arena request recovery failed: model configuration/authentication/context cannot recover. Closing the runtime with failure status.",
        );
        await onFatal(failure);
        return;
      }
      active = true; // Hold the slot until prompt preflight or actual agent activity settles.
      report(
        `Arena request recovery: continuing ${pending.reason} at ${now()}.`,
      );
      try {
        send({
          id: `arena-recovery-prompt-${++sequence}`,
          type: "prompt",
          message: continueMessage(pending.reason),
        });
      } catch (error) {
        active = false;
        plan = pending;
        throw error;
      }
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
        request.reject(new Error("Continuous session stopped"));
      }
      states.clear();
    },
  };
}
