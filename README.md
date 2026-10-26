# Dexter Local

A clean-room, personal desktop assistant for Windows inspired by the broad feature set of Dexter. It does not include code, models, or assets from the installed Dexter app.

## Free by default

Dexter Local has no sign-in, subscription, API key, telemetry, or cloud AI dependency. Built-in desktop commands work offline. Open-ended chat is optional and can use an Ollama model running on this computer; the app sends that chat only to `127.0.0.1:11434` when you enable it in Settings. The local model itself is optional and not bundled.

## Run it on Windows

1. Install Node.js 24 if it is not already installed.
2. Double-click `run.bat`. The first run installs the free Electron runtime from npm, then opens Dexter Local. Later runs start the app directly.

You can also use a terminal in this folder:

```powershell
npm ci
npm start
```

## What it can do

Type `help` in the assistant to see commands. The current version supports:

- List apps registered in the Windows Start menu and open an exact match.
- Open a folder you select in File Explorer.
- Capture the primary display and save the screenshot to a path you choose.
- Read clipboard text only when you explicitly ask, or copy text to the clipboard.
- Answer basic time questions offline and speak replies with a built-in system voice.
- Chat locally with an already installed Ollama model when you enable local AI in Settings.

For Ollama chat, install and start Ollama separately, download a model you want to run, then enter its installed name in Dexter Local settings. See the [Ollama chat API documentation](https://docs.ollama.com/api/chat). Without Ollama, all built-in commands still work.

## Privacy and boundaries

- App discovery reads the Windows Start menu. App launching is limited to an app ID returned by that OS list; Dexter Local does not run arbitrary shell commands.
- Clipboard text is shown for the current session only. It is excluded from saved chat history and from optional model chat history.
- Screenshots are saved only after you request one and choose a destination.
- Conversation history and preferences are stored in local app storage on this computer. Use **Clear chat history** in Settings to remove the conversation.
- The optional model feature calls the fixed loopback address `127.0.0.1`; there is no configurable remote model host.

This is an early personal-use version. It currently targets Windows and does not include cloud accounts, billing, OBS controls, wake-word listening, or all features found in the original app.
