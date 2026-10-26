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

## Features

The sidebar contains Assistant, Desktop, Music, Commands, Routines, Activity, Integrations, Stream panel, and Settings.

- **Assistant:** offline command handling, optional chat with a local Ollama model, and built-in speech output.
- **Desktop:** list and launch Start menu apps; choose folders; save primary-display screenshots; read or write the clipboard; query battery, visible windows, and displays; read upcoming events from a local `.ics` calendar file; open Windows notification settings; confirm before locking Windows or turning displays off.
- **Music:** play, seek, queue, repeat, and adjust the volume for audio files you choose on this computer.
- **Commands:** save phrase shortcuts for the app's allowlisted local commands.
- **Routines:** save and manually run sequences of up to eight allowlisted commands. Folder and screenshot steps still request your input.
- **Activity:** local counts for desktop actions, app launches, routines, and music playback. Clear the history at any time.
- **OBS integration:** connect to OBS WebSocket on `127.0.0.1`; list and switch scenes, start or stop streaming and recording, and mute local OBS inputs. OBS Studio must be installed with its WebSocket server enabled. The password is used for the session and is not saved.
- **Stream panel / companion / designer:** an always-on-top quick panel (`Ctrl+Shift+O`), an animated companion, and a local accent color setting.
- **Voice:** speech output uses a system voice. Optional speech input, `Ctrl+Shift+Space`, and the “Hey Dexter” wake phrase use Chromium speech recognition; the app warns that audio may be processed by its recognition provider. Wake listening is off unless you enable it. Keep speech input off for fully local use.
- **Diagnostics and updates:** export a small local runtime report that excludes chat and personal content; open the GitHub project to review updates manually.

For local AI chat, install and start Ollama separately, download a model you want to run, then enter its installed name in Dexter Local settings. Requests go to the fixed loopback endpoint `127.0.0.1:11434`; no Ollama account or paid API is required. See the [Ollama chat API documentation](https://docs.ollama.com/api/chat). Without Ollama, desktop commands and local music still work.

## Privacy and boundaries

- App discovery reads the Windows Start menu. App launching is limited to an app ID returned by that OS list; Dexter Local does not run arbitrary shell commands.
- Clipboard text is shown for the current session only. It is excluded from saved chat history and from optional model chat history.
- Calendar event titles and locations are shown for the current session only and are excluded from saved chat and model history.
- Visible window names are excluded from saved chat and model history.
- Screenshots are saved only after you request one and choose a destination.
- Conversation history and preferences are stored in local app storage on this computer. Use **Clear chat history** in Settings to remove the conversation.
- The optional model feature calls the fixed loopback address `127.0.0.1`; there is no configurable remote model host.
- OBS connects only to `127.0.0.1`. Its password is not retained after connecting.
- Optional speech recognition is the only feature that may send audio to a third-party recognition service; it is off until enabled and approved. Wake listening stays on only while its setting is enabled and the app is open.
- Local activity history stores generic action labels, not chat text, clipboard contents, app names, or file paths.

## Differences from the original app

This is a clean-room local implementation, not a byte-for-byte copy. It does not include Dexter's private cloud APIs, Clerk sign-in, billing, hosted analytics, or server-side proactive workflows. Calendar reads a local `.ics` file you choose or opens a local calendar app; it does not read a cloud calendar account. Music uses local files instead of account-based streaming services. Some remote-service features therefore have local substitutes instead of account-backed parity.

The app currently targets Windows. First-run dependency download requires internet, but no paid service is used.
