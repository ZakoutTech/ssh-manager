# SSH Config Manager

A visual editor for `~/.ssh/config` in VS Code, the sibling of [Dotenv Manager](https://github.com/ZakoutTech/dotenv-manager). Keep hosts in named groups, add and edit them in a dialog, connect with one click, and control `ssh-agent` without leaving the editor, while the file on disk stays a plain ssh config.

## Features

- **Hosts at a glance.** Every `Host` and `Match` block is a card showing `user@hostname:port`, its key file, jump host and agent forwarding. Expand a card to see and edit every option inline, with suggestions for option names and values.
- **Add / Edit Host dialog.** Alias, host name, user, port, key file (pick one of your keys, browse, or generate a new one), jump host, the common yes/no options, a comment and any other option. A live preview shows the exact lines that will be written.
- **Groups.** Organise hosts into groups (`# === Work ===` comments, the same convention as Dotenv Manager). Drag and drop hosts and groups, or use <kbd>Alt</kbd>+<kbd>↑</kbd> / <kbd>Alt</kbd>+<kbd>↓</kbd>. **Sort A→Z** on a group, or **Sort all A→Z** in the toolbar, the Hosts view menu or the Command Palette, orders hosts by name; wildcard and `Match` blocks stay last, where defaults belong, and groups keep their order.
- **Connect.** **Connect** opens a terminal running `ssh <alias>`, **Remote** opens a VS Code window on the host (Remote - SSH), **Copy** copies the command.
- **Install your key on a host.** **Install key** on a host (or right-click it in the Hosts view) picks a public key, with the host's own `IdentityFile` first, and runs `ssh-copy-id` in a terminal: type the password once, and from then on ssh logs in with the key. On Windows, which has no `ssh-copy-id`, the same is done with `ssh` in PowerShell.
- **ssh-agent.** A status bar item shows how many keys are loaded. Click it, or use the **Agent** button in the editor, for a dialog to:
  - start an agent. VS Code, its Git and every _new_ integrated terminal then use it automatically (`SSH_AUTH_SOCK` is set for them);
  - add keys (passphrases are asked in a password box and can be stored in the macOS Keychain), remove one or all;
  - open a terminal connected to the agent, or run the classic `eval "$(ssh-agent -s)"` in a new terminal (`eval (ssh-agent -c)` for fish).

  The same panel is in the **SSH** activity bar view.

- **Generate keys.** Ed25519 (default), RSA 4096 or ECDSA with `ssh-keygen`, optionally with a passphrase. Then add the key to the agent, use it for the host, copy the public key, or install it on the server with `ssh-copy-id`. Existing files are never overwritten.
- **Hosts view.** The **SSH** activity bar container lists every host, also from files pulled in with `Include`, with inline Connect / Remote / Edit actions.
- **Problems.** A `Host *` that comes before other hosts (it overrides their options), duplicate aliases, unknown options, bad ports and missing key files are shown on the cards and in the **Problems** panel.
- **Commented-out hosts and options.** **Disable** comments a whole host out (`# Host …`) or a single option; **Enable** brings it back.
- **Include files.** Files included with `Include` (globs too) are listed in the editor's **File** dropdown and the Hosts view, and open in the same editor.
- **Safe editing.** Every change is a normal edit to the text document: undo/redo, save and the unsaved-changes marker work as usual, and you can keep the text editor open beside the GUI. Lines you don't touch are written back exactly as they were. Before the first save of a session, a copy of the file is kept in `~/.ssh/backups/`; **Restore Config Backup…** shows a diff and puts a backup back.

## Usage

- Click the **SSH** icon in the activity bar, then **Open SSH Config Manager** (or run it from the Command Palette). If you have no `~/.ssh/config` yet, you're offered to create it with the permissions ssh expects (`~/.ssh` 700, `config` 600).
- In the editor: **+ Host** opens the dialog; click a host's name to expand it; hover a host for **Connect**, **Remote**, **Copy**, **Install key**, **Edit**, **Duplicate**, **Disable** and **Delete**; double-click a card to edit it.
- **Open as text** (toolbar or editor title bar) switches to the text editor; **Preview** shows the text beside the GUI.

### Why "new terminals" for the agent?

An extension cannot change the environment of a shell that is already running. When SSH Config Manager starts an agent, VS Code itself and every integrated terminal opened afterwards get `SSH_AUTH_SOCK`. For terminals that were already open, run **Run ssh-agent eval in Terminal**, or open a new one. On macOS the system agent (launchd) is usually already running and is used as is.

On Windows the OpenSSH Authentication Agent is a service; **Start agent** tries `Start-Service ssh-agent`, which may need an administrator PowerShell.

## Settings

| Setting                              | Default         | Description                                                            |
| ------------------------------------ | --------------- | ---------------------------------------------------------------------- |
| `sshConfigManager.configPath`        | `~/.ssh/config` | The config file to manage.                                             |
| `sshConfigManager.keys.directory`    | `~/.ssh`        | Where keys are listed from and generated in.                           |
| `sshConfigManager.statusBar.enabled` | `true`          | Show the agent status in the status bar.                               |
| `sshConfigManager.backup.enabled`    | `true`          | Back up a config file before its first save in a session (`backups/`). |
| `sshConfigManager.backup.keep`       | `10`            | Backups kept per file.                                                 |
| `sshConfigManager.agent.keyLifetime` | (none)          | `ssh-add -t` lifetime for added keys, e.g. `8h`.                       |
| `sshConfigManager.agent.useKeychain` | `true`          | macOS: remember passphrases in the Keychain.                           |

## File format

Structure comes from ordinary comments, so the file works with every ssh:

```ssh-config
# Global options
AddKeysToAgent yes

# === Work ===
# Servers at the office

# Entry point for everything internal
Host bastion
    HostName bastion.example.com
    User admin

Host web-1 web-2
    HostName 10.0.0.12
    ProxyJump bastion

# Host old-db
#   HostName 10.0.0.9

Host *
    ServerAliveInterval 60
```

- `# === Name ===` starts a group; `#` lines right below it are the group's comment.
- `#` lines directly above a `Host` line are that host's comment.
- `# Host …` followed by commented-out options is a disabled host; `# Option value` inside a host is a disabled option. Prose comments stay comments.

## Privacy

Passphrases never appear on a command line: `ssh-add` and `ssh-keygen` ask for them through a small `SSH_ASKPASS` helper that talks to the extension over a private socket. Nothing leaves your machine.

## Development

```sh
npm install
npm run build             # dist/extension.js + dist/webview.js
npm test                  # unit tests (vitest)
npm run test:integration  # VS Code integration tests (temp config, their own ssh-agent)
npm run preview           # the editor GUI in a browser, with a simulated host
npm run install:code      # package and install into VS Code (install:cursor for Cursor)
```
