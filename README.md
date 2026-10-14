![Spicetify WebSocket Client Extension](assets/banner.png)

[![GitHub License](https://img.shields.io/github/license/tobfd/spicetify-connect-api?style=for-the-badge&logo=github&color=240046)](https://github.com/tobfd/spicetify-connect-api/blob/master/LICENSE)
[![GitHub Release](https://img.shields.io/github/v/release/tobfd/spicetify-connect-api?style=for-the-badge&logo=github&color=3C096C)](https://github.com/tobfd/spicetify-connect-api/releases/latest)
[![GitHub Release](https://img.shields.io/github/v/release/tobfd/spicetify-websocket?style=for-the-badge&logo=python&logoColor=white&label=spicetify-websocket&color=5A189A)](https://github.com/tobfd/spicetify-websocket)
[![Downloads](https://img.shields.io/github/downloads/tobfd/spicetify-connect-api/spicetify-connect-api.js?displayAssetName=false&style=for-the-badge&logo=github&label=Downloads&color=7B2CBF)](https://github.com/tobfd/spicetify-connect-api/releases/latest)

A lightweight, feature-rich JavaScript extension for Spicetify that acts as a real-time bi-directional bridge between the Spotify Desktop Client and a WebSocket server (e.g., Python / Home Assistant).

---

## ✨ Features

- **Full-State Event Architecture**: Every event (except `Ping`) emits a unified, complete snapshot of the Spotify player state.
- **Native Settings UI**: Access configuration settings directly inside Spotify by clicking your **Profile Picture**.
- **API Key Authentication**: Optional security token support to protect incoming commands and authenticate outgoing push events.
- **WSS / Secure Connections**: Full support for encrypted `wss://` connections for remote setups or local SSL environments.
- **Automatic Reconnection**: Reconnects automatically with exponential backoff (doubling up to 30 seconds) if the server drops or restarts.
- **Real-Time Push Events**: Emits instant WebSocket events on player state changes:
    - `InitialState`: Dispatched immediately upon WebSocket connection.
    - `SongChanged`: Triggered on track changes.
    - `PlayPauseChanged`: Triggered when playback is paused or resumed.
    - `VolumeChanged`: Triggered on volume adjustments (uses trailing debounce to avoid network spam).
    - `RepeatChanged`: Triggered when repeat mode is changed.
    - `ShuffleChanged`: Triggered when shuffle mode is toggled.
    - `SeekChanged`: Triggered when manually seeking or scrubbing through a track.
    - `HeartChanged`: Triggered when a track is saved to or removed from Liked Songs.
    - `BufferingChanged`: Triggered when Spotify finishes buffering (for example shortly after a song change or seek).
    - `Ping`: Triggered periodically every 30 seconds as a heartbeat.
- **Full Control Commands**: Supports incoming JSON requests to control playback, volume, shuffle, repeat, seeking, track liking, and status queries.

---

## ⚙️ Configuration & Settings

You can configure the extension directly within Spotify:

1. Click on your **Profile Picture** in the top-right corner of Spotify.
2. Click **Connect API Settings**.
3. Adjust your settings in the popup modal:
    - **WebSocket Server URL**: Default is `ws://127.0.0.1:9090` (server on the same PC). Use `wss://SERVER_IP:9090` or `wss://your-domain` for a server on another device; Spotify blocks unencrypted `ws://` connections to other devices.
    - **API Key / Secret Token (Optional)**: Set a custom secret token matching your server configuration for authenticated setups.
    - **Reconnect Interval (ms)**: Initial delay before reconnecting (minimum `1000ms`). It doubles after each failed attempt, up to 30 seconds.

    **Save & Reconnect** applies the settings immediately and reconnects to the (new) server.

---

## 📥 Installation

### Marketplace Installation (Recommended)

1. Open the Spicetify Marketplace in Spotify and search for ``Connect API``.
2. Click **Install** to add the extension to your Spotify client.

### Manual Installation

1. Download [spicetify-connect-api.js](https://github.com/tobfd/spicetify-connect-api/releases/latest/download/spicetify-connect-api.js).

2. Place the file in the appropriate path for your operating system:
    - **Windows**: `%appdata%\spicetify\Extensions\` (Paste in `Win + R`)
    - **Linux / macOS**: `~/.config/spicetify/Extensions/`

3. Enable the extension in your terminal:
```bash
spicetify config extensions spicetify-connect-api.js
```

4. Apply the changes:
```bash
spicetify apply
```

---

## 🐍 Recommended Python Library

If you are building a Python application to interact with this extension, use the companion Python package:

👉 **[tobfd/spicetify-websocket](https://github.com/tobfd/spicetify-websocket)**

It handles the WebSocket server setup, SSL/WSS contexts, API Key verification, event listeners, response matching, and typed command execution out of the box!

---

## 📡 WebSocket Protocol

The extension connects as a WebSocket client (default `ws://127.0.0.1:9090`). The server sends JSON requests such as

```json
{ "requestName": "SetVolume", "requestId": "unique-id-123", "token": "your-optional-api-key", "payload": { "level": 0.8 } }
```

and the extension answers with a `Response` (including a machine-readable error `code` on failure) and pushes events with the complete player state.

The full specification (all requests, events, error codes, the state payload and versioning rules) is in **[PROTOCOL.md](PROTOCOL.md)**, with a machine-readable JSON Schema in [`protocol/messages.schema.json`](protocol/messages.schema.json). Current protocol version: **1**.
