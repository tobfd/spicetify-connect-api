# Spicetify WebSocket Client Extension
![Spicetify WebSocket Client Extension](assets/banner.png)

A lightweight, standalone JavaScript extension for Spicetify that acts as a real-time bi-directional bridge between the Spotify Desktop Client and a WebSocket server (e.g., Python).

## Features

- **Automatic Reconnection**: Automatically attempts to reconnect to the WebSocket server if the connection drops or the server restarts.
- **Real-Time Push Events**: Emits instant WebSocket events on player state changes:
    - `InitialState`: Dispatched immediately upon WebSocket connection (includes live-patched progress timestamp).
    - `SongChanged`: Triggered on track changes.
    - `PlayPauseChanged`: Triggered when playback is paused or resumed.
    - `VolumeChanged`: Triggered on volume adjustments (uses trailing debounce to avoid network spam).
    - `RepeatChanged`: Triggered when repeat mode is changed.
    - `ShuffleChanged`: Triggered when shuffle mode is toggled.
    - `SeekChanged`: Triggered only when manually seeking or scrubbing through a track.
- **URL & URI Support**: Plays tracks, albums, or playlists using either native Spotify URIs or standard HTTPS URLs.
- **Full Control Commands**: Supports JSON incoming requests to control playback, volume, shuffle, repeat, seeking, and status queries.
- **Zero UI Overhead**: Operates entirely in the background without injecting bloated UI elements into Spotify.

---

## Installation

### Manual Installation

1. Download `spicetify-connect-api.js`.

2. Place the file in the appropriate path for your operating system:
    - **Windows**: `C:\Users\%username%\AppData\Roaming\spicetify\Extensions\` (Just paste it to `Win + R`.)
    - **Linux / macOS**: `~/.config/spicetify/Extensions/`

3. Enable the extension in your terminal:
```bash
spicetify config extensions spicetify-connect-api.js
```

4. Apply the change:
```bash
spicetify apply
```

---

## WebSocket API Specification

By default, the extension connects to `ws://127.0.0.1:9090`.

### Incoming Requests (Server -> Spotify Client)

Send JSON messages in the following structure:
```json
{
  "requestName": "SetVolume",
  "requestId": "unique-id-123",
  "payload": {
    "level": 0.8
  }
}
```

#### Available Commands

| Request Name | Payload Parameters | Description |
| :--- | :--- | :--- |
| `Play` | *None* | Resumes playback. |
| `Pause` | *None* | Pauses playback. |
| `TogglePlay` | *None* | Toggles play/pause state. |
| `NextSong` | *None* | Skips to the next track. |
| `PreviousSong` / `Back` | *None* | Standard Spotify back action (resets to 00:00 if playing > 2s). |
| `ForcePreviousSong` / `ForceBack` | *None* | Forces skip to the actual previous track regardless of elapsed time. |
| `SetVolume` | `level` (float `0.0` - `1.0`) | Sets the volume level. |
| `SetRepeat` | `mode` (`0`: Off, `1`: All, `2`: One) | Sets repeat mode. |
| `SetShuffle` | `state` (boolean) | Enables/disables shuffle. |
| `SetMute` | `state` (boolean) | Mutes/unmutes audio. |
| `PlayUri` | `uri` or `url` (string) | Plays a item via URI (`spotify:track:...`) or URL (`https://open.spotify.com/track/...`). |
| `Seek` | `position` (number in ms) | Seeks to a specific track position in milliseconds. |
| `GetPlayerState` | *None* | Returns full player state snapshot (with patched live `position_as_of_timestamp`). |
| `GetCurrentTrack` | *None* | Returns active track object. |
| `GetVolume` | *None* | Returns current volume level. |
| `GetPlayPause` | *None* | Returns current play/pause status. |

---

### Outbound Event / Response Format (Spotify Client -> Server)

#### Event Push Notification
Emitted event types include: `InitialState`, `SongChanged`, `PlayPauseChanged`, `VolumeChanged`, `RepeatChanged`, `ShuffleChanged`, `SeekChanged`.

```json
{
  "eventName": "SongChanged",
  "payload": { ... }
}
```

#### Command Response

```json
{
  "eventName": "Response",
  "requestId": "unique-id-123",
  "success": true,
  "payload": { ... }
}
```