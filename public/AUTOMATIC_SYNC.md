# Org Memory automatic sync

The connector is a user-level macOS background service. It reads supported Claude and Codex conversation stores from the account that installed it and sends changed conversations to the configured Org Memory server.

It does not require `sudo` or display a folder picker. Running the installer is the installation action. The connector cannot bypass macOS protections if the operating system denies access.

## Install

Generate an installation command from **Import my history → Generate connector key**, then run it in Terminal:

```sh
curl -fsSL https://memory.example.com/install.sh | sh -s -- \
  --server https://memory.example.com \
  --token om_REDACTED
```

To inspect it first:

```sh
curl -fsSLO https://memory.example.com/install.sh
less install.sh
sh install.sh --server https://memory.example.com --token om_REDACTED
```

## Installed files

- `~/Library/Application Support/OrgMemory/connector.js` — connector code.
- `~/Library/Application Support/OrgMemory/run.sh` — retrieves the credential and starts the connector.
- `~/Library/Application Support/OrgMemory/state.json` — timestamps for incremental uploads.
- `~/Library/LaunchAgents/in.flent.org-memory.plist` — runs after login and once per hour.
- `~/Library/Logs/OrgMemory/` — sync and error logs.
- A personal connector credential stored in macOS Keychain.

The connector reads conversation data from `~/.claude/projects` and supported Codex SQLite databases under `~/.codex`. It does not intentionally read Claude/Codex authentication files, settings, shell snapshots, or caches.

## Check and run

```sh
launchctl print gui/$(id -u)/in.flent.org-memory
launchctl kickstart -k gui/$(id -u)/in.flent.org-memory
tail -f "$HOME/Library/Logs/OrgMemory/sync.log"
tail -f "$HOME/Library/Logs/OrgMemory/error.log"
```

The first run uploads existing supported sessions. Later runs use `state.json` to upload only new or changed sessions.

## Update

Run a newly generated installation command again. It replaces the connector, updates its Keychain credential, reloads the LaunchAgent, and preserves sync state.

## Uninstall

```sh
curl -fsSL https://memory.example.com/install.sh | sh -s -- \
  --uninstall --server https://memory.example.com
```

This removes the connector, LaunchAgent, state, and Keychain credential. Logs are retained for auditing and can be deleted separately.

## Security

- Use HTTPS outside local development.
- Keys are personal and revocable; never use another employee's key.
- The key is shown once and moved into Keychain during installation.
- IP addresses are audit metadata only, never user or device identity.
- Production should replace command-line connector keys with short-lived enrollment codes.
