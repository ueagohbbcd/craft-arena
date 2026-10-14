# Model relay

A participant's model endpoint when the participant container has no network of its own. It forwards every request to one configured base URL and reaches nothing else, so it is the participant's whole egress allowlist. With a key configured it replaces the caller's `Authorization` header, so the key stays outside the participant container.

It does nothing else: no metering, rate limits, queueing, request rewriting or protocol translation. Those belong in whatever service the upstream URL points at. That can be an official API, or any service on the host (an OAuth-to-API bridge, a metering proxy, a proxy chain); this project does not ship or depend on one. When the participant container has its own network and Pi profile, the relay is not used at all. Both setups are described in [infra/README.md](../../infra/README.md#模型接入).

```sh
MODEL_RELAY_UPSTREAM=https://api.openai.com/v1 MODEL_RELAY_API_KEY=... node packages/model-relay/cli.mjs
```

| Variable               | Default   | Meaning                                                                                                            |
| ---------------------- | --------- | ------------------------------------------------------------------------------------------------------------------ |
| `MODEL_RELAY_UPSTREAM` | required  | Base URL, `http(s)`, no credentials, query or fragment. `POST /chat/completions` goes to `<base>/chat/completions` |
| `MODEL_RELAY_API_KEY`  | unset     | Sent as `Authorization: Bearer <key>` in place of the caller's header. Unset: the caller's header passes through   |
| `MODEL_RELAY_PORT`     | `8080`    | Listen port                                                                                                        |
| `MODEL_RELAY_HOST`     | `0.0.0.0` | Listen address                                                                                                     |

Behaviour:

- Method, path below the base, query, body and headers pass through; hop-by-hop headers (`Connection`, `Proxy-Authorization`, …) and `Host` do not. Only the path and query of the request target are used, so an absolute or `//host` target still lands on the upstream.
- Bodies stream both ways, with no request or response timeout. When the caller disconnects, the upstream request is cancelled.
- An unreachable upstream returns `502`. Each finished request logs one JSON line: method, path, status and duration, never headers or bodies.

The launcher points Pi at the relay with `OPENAI_BASE_URL=http://<relay>:8080` and no `OPENAI_API_KEY`; Pi then sends `Bearer unused`, which the relay replaces.

Tests: [tests/model-relay.test.mjs](../../tests/model-relay.test.mjs), and the relay paths in [tests/integration-pi.test.mjs](../../tests/integration-pi.test.mjs) (real Pi through the relay, image tool results, the shipped launcher).
