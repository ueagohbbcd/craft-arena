import { getGlobalDispatcher, setGlobalDispatcher } from "undici";

/** The gateway owns queue admission; HTTP idle timers must not cancel that wait. */
export function installGatewayTransport({
  baseUrl = process.env.OPENAI_BASE_URL,
  dispatcher = getGlobalDispatcher(),
} = {}) {
  if (!baseUrl) return;
  const url = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("OPENAI_BASE_URL must be an HTTP(S) gateway URL");
  const origin = url.origin;
  const previous = getGlobalDispatcher();
  const transport = {
    dispatch(options, handler) {
      const matches = new URL(String(options.origin)).origin === origin;
      return dispatcher.dispatch(
        matches ? { ...options, headersTimeout: 0, bodyTimeout: 0 } : options,
        handler,
      );
    },
    close: (...args) => dispatcher.close(...args),
    destroy: (...args) => dispatcher.destroy(...args),
  };
  setGlobalDispatcher(transport);
  return () => {
    if (getGlobalDispatcher() === transport) setGlobalDispatcher(previous);
  };
}

// Loaded in the Pi child through Node --import, before the native client uses fetch.
installGatewayTransport();
