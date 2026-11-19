# hubdash

A small new-tab dashboard for Claude and Codex subscriptions routed through
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI). It shows how much of each rate limit is left and
where your tokens went.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshot-dark.png">
  <img alt="hubdash showing Claude and Codex limit cards above a token usage chart stacked by model" src="docs/screenshot-light.png">
</picture>

## What it shows

- **A card per provider**: tokens today and over the last 30 days, then each limit (5-hour, weekly, Claude's
  per-model weekly). For each one: how much is left, how far through the window you are, when it resets, and a
  pace estimate: what you'll have left at reset, or roughly when you'll run out.
- **Codex resets available**, with the next expiry.
- **Token usage over time** for a day, week, month, or 6 months. Filter by provider or model, stack by token
  type (input, cache read, cache write, output) or by model, or switch to a table.

## How it works

One Bun binary serves the page and a small JSON API:

- **Limits** come from each provider's usage endpoint, called through CLIProxyAPI's management API
  (`/v8/management/requests/api-call`), so the proxy supplies the account's OAuth token. They're refreshed every 5 minutes.
- **Token usage** is read from the SQLite database kept by
  [CPA-Manager-Plus](https://github.com/seakee/CPA-Manager-Plus) (`usage_events`).

The usage endpoints (`api.anthropic.com/api/oauth/usage`, `chatgpt.com/backend-api/wham/usage`) are undocumented
and may change. If one fails, that account shows "Limits unavailable" and the rest of the page keeps working.

## Requirements

- CLIProxyAPI with the management API enabled, and CPA-Manager-Plus recording usage, on the same machine
- [Bun](https://bun.sh) to build (the server machine only needs the compiled binary)

## Configuration

| Variable       | Default                              | Purpose                                        |
| -------------- | ------------------------------------ | ---------------------------------------------- |
| `PORT`         | `18400`                              | Port to listen on (always binds `127.0.0.1`)   |
| `PROXY_URL`    | `http://127.0.0.1:8317`              | CLIProxyAPI base URL                           |
| `SECRETS_FILE` | `~/cliproxyapi/secrets.env`          | File containing a `MGMT_KEY=` line             |
| `USAGE_DB`     | `~/cpamp/data/usage.sqlite`          | CPA-Manager-Plus database (opened read-only)   |

## Development

```sh
bun install
bun test
bun run typecheck
bun run dev        # needs the proxy and usage DB reachable, e.g. over an ssh tunnel
```

## Deploying

`./deploy <ssh-host>` runs the tests and typecheck, builds a `linux-x64` binary, copies it and
`hubdash.service` to the host, and restarts it as a systemd user service. (`HUB_HOST` works instead of the
argument.) To keep it running after you log out, the user needs lingering (`loginctl enable-linger`).

The service only listens on localhost. To reach it from your other devices, put something in front of it, for
example [Tailscale Serve](https://tailscale.com/kb/1312/serve):

```sh
sudo tailscale serve --bg --https=443 http://127.0.0.1:18400
```

Then set that URL as your browser's homepage or new-tab page.
