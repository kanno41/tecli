# tecli

Time entry CLI, web UI, and TUI for Costpoint.

## Setup

Requires [Node.js](https://nodejs.org/) 18 or later.

```bash
git clone <repo-url>
cd tecli
npm install
npm link
te login
```

`npm link` makes the `te` command available globally. `te login` prompts for your username and password and stores them in your OS keychain (macOS Keychain, GNOME Keyring on Linux, or an encrypted file as fallback). Nothing is saved in plaintext.

## Usage

```
te show                        # show timesheet
te set <line> <day> <hours>    # set hours (e.g. te set 1 4 8)
te setm 1 1 8, 1 2 8, 1 3 8   # set multiple cells
te add ZLEAVE.HOL              # add a project line
te add ZLEAVE.FTB RHB          # add a multi-charge project line
te sign                        # sign timesheet
te leave                       # show leave balances
te server                      # start the web UI (port 3000)
te tui                         # start the interactive terminal UI
te logout                      # remove stored credentials
```

## MCP Server

The MCP server exposes timesheet tools to AI assistants like Claude. It uses stdio transport and the same credential system as the CLI.

### Available tools

| Tool | Description |
|------|-------------|
| `show_timesheet` | Show current timesheet with hours, status, and comments |
| `set_hours` | Set hours for a specific line and day |
| `set_hours_bulk` | Set hours for multiple cells at once |
| `add_project` | Add a charge code (supports shortcuts: `pto`, `flex`, `personal`, `holiday`, `lwop`, `holdefer`) |
| `sign_timesheet` | Sign/submit the timesheet |
| `get_leave_balances` | Show leave balances and recent activity |
| `save_with_explanation` | Save with a revision explanation (when required) |

### Installing in Claude Code

```bash
claude mcp add tecli -- node /path/to/tecli/mcp-server.js
```

Replace `/path/to/tecli` with the actual path to this repo. For example:

```bash
claude mcp add tecli -- node ~/dev/tecli/mcp-server.js
```

To verify it was added:

```bash
claude mcp list
```

### Installing in Claude Desktop

Add to your Claude Desktop config file:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "tecli": {
      "command": "node",
      "args": ["/path/to/tecli/mcp-server.js"]
    }
  }
}
```

### Installing in other MCP clients

The server uses stdio transport. Point your client at:

```
node /path/to/tecli/mcp-server.js
```

### Credentials

The MCP server uses the same credential resolution as the CLI:

1. Stored credentials from `te login` (`~/.tecli.json` + OS keychain)
2. Environment variables (`COSTPOINT_URL`, `COSTPOINT_USERNAME`, `COSTPOINT_PASSWORD`)

If you haven't run `te login` yet, do that first — the MCP server picks up stored credentials automatically.

## Disclaimer

This repository is not affiliated, associated, authorized, endorsed by, or in any way officially connected with Deltek, Inc.
