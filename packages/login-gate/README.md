# Login gate

Trusted service in front of the Minecraft server, one per participant (`gate-<agent>` in the generated Compose file). It is the identity boundary of the native runtime: the participant's bots run inside its container, and the gate decides which characters that container may log in as.

- It reads the handshake and the Login Start packet, admits only the participant's characters (names compared case-insensitively) and at most one connection per character, then forwards bytes unchanged in both directions. It keeps no game state and rewrites nothing.
- Status pings pass through. Transfers and legacy pings are refused. A refused login gets a login-state Disconnect with the reason.
- The participant's network contains only its own gate; the server and other gates are unreachable from it. The server runs in offline mode, so this network layout is what makes the name check binding.
- With RCON settings it also serves the session read-only on `GATE_SESSION_PORT`: `GET /v1/session?username=<character>` returns `{ok, result}`, the protocol v1 session object for that character for the native bot host and Pi launcher. The endpoint is read-only and never accepts game actions.

| Variable                                                 | Default        | Meaning                                          |
| -------------------------------------------------------- | -------------- | ------------------------------------------------ |
| `GATE_USERNAMES`                                         | required       | This participant's characters, comma list        |
| `GATE_UPSTREAM_HOST`, `GATE_UPSTREAM_PORT`               | —, 25565       | The Minecraft server                             |
| `GATE_HOST`, `GATE_PORT`                                 | 0.0.0.0, 25565 | Where the gate listens                           |
| `GATE_RCON_HOST`, `GATE_RCON_PORT`, `GATE_RCON_PASSWORD` | unset          | Session endpoint; without a host, none           |
| `GATE_SESSION_PORT`                                      | 8080           | Session endpoint port                            |
| `GATE_SESSION_ID`                                        | generated      | Fallback session ID when `arena:config` has none |

`node packages/login-gate/cli.mjs` starts both. `startLoginGate` and `startSessionEndpoint` are exported for tests and other launchers.
