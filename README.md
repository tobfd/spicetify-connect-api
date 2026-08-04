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
- **Automatic Reconnection**: Safely attempts auto-reconnecting if the server drops or restarts.
- **Real-Time Push Events**: Emits instant WebSocket events on player state changes:
    - `InitialState`: Dispatched immediately upon WebSocket connection.
    - `SongChanged`: Triggered on track changes.
    - `PlayPauseChanged`: Triggered when playback is paused or resumed.
    - `VolumeChanged`: Triggered on volume adjustments (uses trailing debounce to avoid network spam).
    - `RepeatChanged`: Triggered when repeat mode is changed.
    - `ShuffleChanged`: Triggered when shuffle mode is toggled.
    - `SeekChanged`: Triggered when manually seeking or scrubbing through a track.
    - `HeartChanged`: Triggered when a track is saved to or removed from Liked Songs.
    - `Ping`: Triggered periodically every 30 seconds as a heartbeat.
- **Full Control Commands**: Supports incoming JSON requests to control playback, volume, shuffle, repeat, seeking, track liking, and status queries.

---

## ⚙️ Configuration & Settings

You can configure the extension directly within Spotify:

1. Click on your **Profile Picture** in the top-right corner of Spotify.
2. Click **Connect API Settings**.
3. Adjust your settings in the popup modal:
    - **WebSocket Server URL**: Default is `ws://127.0.0.1:9090`. Use `wss://IP:PORT:9090` for encrypted connections or `wss://DOMAIN:PORT` for remote connections.
    - **API Key / Secret Token (Optional)**: Set a custom secret token matching your server configuration for authenticated setups.
    - **Reconnect Interval (ms)**: Set how fast the extension attempts to reconnect on disconnect (Minimum `1000ms`).

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

## 📡 WebSocket API Specification

By default, the extension connects to `ws://127.0.0.1:9090`.

### Incoming Requests (Server -> Spotify Client)

Send JSON messages in the following structure (include `"token"` if API Key is set in settings):

```json
{
  "requestName": "SetVolume",
  "requestId": "unique-id-123",
  "token": "your-optional-api-key",
  "payload": {
    "level": 0.8
  }
}
```

#### Available Commands

| Request Name                      | Payload Parameters                    | Description                                                                                                          |
|:----------------------------------|:--------------------------------------|:---------------------------------------------------------------------------------------------------------------------|
| `Ping`                            | *None*                                | Responds with `{ "message": "Pong", "timestamp": ... }`.                                                             |
| `Play`                            | *None*                                | Resumes playback.                                                                                                    |
| `Pause`                           | *None*                                | Pauses playback.                                                                                                     |
| `TogglePlay`                      | *None*                                | Toggles play/pause state.                                                                                            |
| `NextSong`                        | *None*                                | Skips to the next track.                                                                                             |
| `PreviousSong` / `Back`           | *None*                                | Standard Spotify back action (resets to 00:00 if playing > 2s).                                                      |
| `ForcePreviousSong` / `ForceBack` | *None*                                | Forces skip to the actual previous track regardless of elapsed time.                                                 |
| `SetVolume`                       | `level` (float `0.0` - `1.0`)         | Sets the volume level.                                                                                               |
| `SetRepeat`                       | `mode` (`0`: Off, `1`: All, `2`: One) | Sets repeat mode.                                                                                                    |
| `SetShuffle`                      | `state` (boolean)                     | Enables/disables shuffle.                                                                                            |
| `SetMute`                         | `state` (boolean)                     | Mutes/unmutes audio.                                                                                                 |
| `SetHeart`                        | `status` (boolean)                    | Likes (`true`) or unlikes (`false`) the current track.                                                               |
| `ToggleHeart`                     | *None*                                | Toggles the like/heart status of the current track.                                                                  |
| `PlayUri`                         | `uri` or `url` (string)               | Plays an item via URI (`spotify:track:...`) or web URL (`https://open.spotify.com/track/...`).                       |
| `Seek`                            | `position` (number in ms)             | Seeks to a specific track position in milliseconds.                                                                  |
| `GetPlayerState`                  | *None*                                | Returns full player state snapshot (with patched live `position_as_of_timestamp`, `volume`, `isMuted`, `isHearted`). |
| `GetCurrentTrack`                 | *None*                                | Returns active track object.                                                                                         |
| `GetVolume`                       | *None*                                | Returns current volume level.                                                                                        |
| `GetPlayPause`                    | *None*                                | Returns current play/pause status.                                                                                   |
| `GetHeart`                        | *None*                                | Returns current track like/heart status (`{ isHearted: boolean }`).                                                  |

---

### Outbound Event / Response Format (Spotify Client -> Server)

#### Event Push Notification
All player events (except `Ping`) emit the **complete player state** in their payload.

Emitted event types include: `InitialState`, `SongChanged`, `PlayPauseChanged`, `VolumeChanged`, `RepeatChanged`, `ShuffleChanged`, `SeekChanged`, `HeartChanged`, `Ping`.

```json
{
  "eventName": "SongChanged",
  "token": "your-optional-api-key",
  "payload": {
    "playerData": {
      "item": { ... },
      "position_as_of_timestamp": 45120,
      "volume": 0.8,
      "is_muted": false,
      "is_hearted": true,
      "timestamp": 1772636000000
    },
    "isPlaying": true,
    "volume": 0.8,
    "isMuted": false,
    "isHearted": true,
    "shuffle": false,
    "repeat": 0,
    "progress": 45120
  }
}
```

#### Command Response

```json
{
  "eventName": "Response",
  "requestId": "unique-id-123",
  "token": "your-optional-api-key",
  "success": true,
  "payload": { ... }
}
```
