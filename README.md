# tecli

Time entry CLI, web UI, and TUI for Costpoint.

## Setup

```bash
git clone <repo-url>
cd costpoint
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

## Disclaimer

This repository is not affiliated, associated, authorized, endorsed by, or in any way officially connected with Deltek, Inc.
