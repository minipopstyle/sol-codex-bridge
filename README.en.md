# Sol ↔ Codex Local Bridge

![Sol ↔ Codex Local Bridge cover](assets/cover.png)

<p align="center"><strong>Exchange context between ChatGPT and Codex locally.</strong></p>

<p align="center"><a href="README.md">中文</a> · <a href="README.en.md">English</a></p>

---

## What is Sol ↔ Codex?

**Sol ↔ Codex Local Bridge** is a Chrome extension and local Bridge for macOS and Windows. It transfers context between ChatGPT and local Codex projects and sessions.

```text
ChatGPT ↔ Chrome Extension ↔ 127.0.0.1:4329 ↔ Codex Project / Session / Git
```

## Features

- Send a complete ChatGPT assistant response or selected text to an existing Codex session or a new project task.
- Read project context, recent progress, session records, Git Diff, and project files back into ChatGPT.
- Discover local Codex projects and sessions after pairing.
- Choose **Auto**, **Always text**, or **Always Markdown file** for both sending and reading.
- Keep all Bridge traffic on the local loopback address.

Reading is explicit and read-only. The extension inserts the result into the current ChatGPT composer and never sends a message automatically.

## Installation

### Requirements

- macOS or Windows;
- Google Chrome;
- Node.js 18+;
- Codex CLI / Codex Desktop installed and signed in.

### 1. Install the Local Bridge

On macOS, double-click the following file in the repository root:

```text
run-in-codex-poc.command
```

On Windows, run PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\Windows\install-run-in-codex-poc.ps1
```

The Bridge uses port `4329`. macOS uses `launchd`; Windows uses the current user's Task Scheduler. Closing the command window does not stop the Bridge.

### 2. Maintenance commands

| Action | macOS | Windows |
| --- | --- | --- |
| Install / start | `run-in-codex-poc.command` | `Windows/install-run-in-codex-poc.ps1` |
| Restart / update | `restart-run-in-codex-poc.command` | `Windows/restart-run-in-codex-poc.ps1` |
| Check status | `status-run-in-codex-poc.command` | `Windows/status-run-in-codex-poc.ps1` |
| Uninstall / clean | `uninstall-run-in-codex-poc.command` | `Windows/uninstall-run-in-codex-poc.ps1` |

`com.sol-codex.run-in-codex-poc.plist` is a macOS template. Do not double-click it.

### 3. Install the Chrome extension

Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select:

```text
chatgpt-extension/
```

### 4. Pair the extension

The installer generates a Pairing Token and copies it to the clipboard. In ChatGPT:

1. Open the target card from an assistant response;
2. Click **Pair** in the card header;
3. Paste the Pairing Token and save;
4. Wait for the project and session lists to refresh.

Pairing is normally a one-time action. The token is stored locally by the extension and Bridge.

## Usage

### Send to Codex

1. Click **Target** beside an assistant response;
2. Choose **Existing session** or **New project task**;
3. Select the project and, when needed, a session;
4. Save the target and click **Send to Codex**.

### Read Codex context

1. Click **Read**;
2. Select a project and session;
3. Grant read permission the first time a project is accessed;
4. Choose project context, recent progress, session record, Git Diff, or project files;
5. Insert the result as text or upload it as a Markdown file.

Selecting a project is not the same as granting read permission. The Bridge stores and checks read permission per project.

## Local first

The Bridge only listens on:

```text
127.0.0.1:4329
```

All non-health API routes require the Pairing Token. Project reads also require explicit permission. The server validates project paths and rejects paths outside the selected project and protected files.

Runtime data is kept locally under:

```text
~/.sol-codex-run-in-codex-poc-publish/
```

The Bridge does not proactively send task content to third-party services.

## Project structure

```text
sol-codex-bridge/
├── chatgpt-extension/       # ChatGPT Chrome extension
├── bridge/                  # Local Bridge and Context API
│   └── lib/                 # Codex, project, session, and permission adapters
├── Windows/                 # Windows maintenance scripts
├── run-in-codex-poc.command # macOS install / start
├── restart-run-in-codex-poc.command
├── status-run-in-codex-poc.command
├── uninstall-run-in-codex-poc.command
├── tests/                   # Publish-version tests
├── assets/                  # README and project assets
└── README.md
```

## Verification

```sh
node --test tests/*.mjs
curl http://127.0.0.1:4329/health
```

## License

No license is currently included. Add an appropriate open-source license before publishing the repository formally.
