import net from "node:net";

/** One-shot control RPC. Game reads and actions stay inside the native module. */
export function request(socketPath, message) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(
      typeof socketPath === "string"
        ? socketPath
        : { host: socketPath.host, port: socketPath.port },
    );
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, end));
        if (response.type === "error") reject(new Error(response.error));
        else resolve(response);
      } catch (error) {
        reject(error);
      }
      socket.end();
    });
    socket.once("error", reject);
    socket.once("close", () => {
      if (buffer && !buffer.includes("\n"))
        reject(new Error("Host closed the RPC without a complete response"));
    });
  });
}

export const cancel = (socketPath, id) =>
  request(socketPath, { type: "cancel", id });
export const status = (socketPath) => request(socketPath, { type: "status" });
export const session = (socketPath) => request(socketPath, { type: "session" });
