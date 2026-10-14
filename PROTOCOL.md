# WebSocket Protocol

This document describes the messages exchanged between the **spicetify-connect-api** extension (running inside Spotify Desktop) and a WebSocket server such as [spicetify-websocket](https://github.com/tobfd/spicetify-websocket) (used by the [Home Assistant integration](https://github.com/tobfd/ha-spicetify-bridge)).

- **Protocol version:** 1
- **Machine-readable schema:** [`protocol/messages.schema.json`](protocol/messages.schema.json) (JSON Schema 2020-12). The extension's tests and the end-to-end tests of spicetify-websocket validate every message against it.

## Roles and transport

- The **extension is the WebSocket client**. It connects to the configured URL (default `ws://127.0.0.1:9090`). Spotify only allows unencrypted `ws://` to `localhost`; use `wss://` for other hosts.
- The **server** sends requests, the extension answers with responses and pushes events on its own.
- Every text frame contains exactly one JSON object.
- After a lost connection the extension reconnects with exponential backoff (base interval from the settings, doubled per attempt, capped at 30 s).

## Authentication

If an API key is configured, **every message in both directions carries it** in the `token` field.

1. Right after connecting, the extension sends an `InitialState` event. Servers should treat the connection as authenticated only once this first message carries the correct token, and close it otherwise (spicetify-websocket uses close code `1008`).
2. The extension ignores requests with a wrong or missing token and answers them with an `unauthorized` error response **without** its own token, so the key is never sent to a server that does not know it.

## Requests (server → extension)

```json
{
  "requestName": "SetVolume",
  "requestId": "4f6e86c9-85c4-4662-bff0-91e6144c400d",
  "token": "your-api-key",
  "payload": { "level": 0.8 }
}
```

`requestId` must be unique per request; the response echoes it. `payload` may be omitted for requests without parameters.

| Request | Payload | Response payload |
|---|---|---|
| `Ping` | – | `{ "message": "Pong", "timestamp": <ms> }` |
| `Play` / `Pause` | – | `{ "isPlaying": <bool> }` |
| `TogglePlay` | – | `{ "isPlaying": <bool> }` |
| `NextSong` | – | `{}` |
| `PreviousSong` / `Back` | – | `{}` (Spotify restarts the track if more than a few seconds have played) |
| `ForcePreviousSong` / `ForceBack` | – | `{}` (always goes to the previous track) |
| `SetVolume` | `level`: number `0.0`–`1.0` | `{ "level": <number> }` |
| `SetRepeat` | `mode`: `0` off, `1` all, `2` one | `{ "mode": <number> }` |
| `SetShuffle` | `state`: boolean | `{ "state": <bool> }` |
| `SetMute` | `state`: boolean | `{ "isMuted": <bool> }`. Muting sets the volume to 0, unmuting restores the previous volume. |
| `SetHeart` | `status`: boolean | `{ "isHearted": <bool> }` |
| `ToggleHeart` | – | `{ "isHearted": <bool> }` |
| `PlayUri` | `uri` (`spotify:track:…`) or `url` (`https://open.spotify.com/…`) | `{ "uri": <string> }`. Fails if Spotify rejects the item. |
| `Seek` | `position`: milliseconds, `>= 0` | `{ "position": <ms> }` |
| `GetPlayerState` | – | full [state payload](#state-payload) |
| `GetCurrentTrack` | – | `{ "track": <item or null> }` |
| `GetVolume` | – | `{ "level": <number> }` |
| `GetPlayPause` | – | `{ "isPlaying": <bool> }` |
| `GetHeart` | – | `{ "isHearted": <bool> }` |

## Responses (extension → server)

```json
{ "eventName": "Response", "requestId": "4f6e…", "success": true, "payload": { "level": 0.8 }, "token": "your-api-key" }
```

A failed request has `success: false`, a human-readable `error` and a machine-readable `code`:

```json
{ "eventName": "Response", "requestId": "4f6e…", "success": false, "payload": {}, "error": "Parameter 'level' must be between 0.0 and 1.0.", "code": "invalid_params" }
```

| Code | Meaning |
|---|---|
| `unauthorized` | Wrong or missing token. Sent without the extension's token. |
| `invalid_params` | A parameter is missing or out of range. |
| `unknown_request` | The extension does not know this `requestName` (e.g. an older version). |
| `unavailable` | The Spicetify API needed for this request is not available in this Spotify version. |
| `command_failed` | Spotify raised an error while executing the request (e.g. `PlayUri` for an unavailable track). |

Receivers should handle unknown codes like `command_failed`. Extensions before protocol version 1 send no `code`.

## Events (extension → server)

```json
{ "eventName": "SongChanged", "token": "your-api-key", "payload": { …state payload… } }
```

| Event | Sent when |
|---|---|
| `InitialState` | Right after connecting. Also carries `protocolVersion` and `extensionVersion`. |
| `SongChanged` | A different track starts. |
| `PlayPauseChanged` | Playback is paused or resumed. |
| `SeekChanged` | The position jumps (seek or scrubbing). |
| `VolumeChanged` | The volume changes (debounced). |
| `RepeatChanged` / `ShuffleChanged` | The repeat mode or shuffle changes. |
| `HeartChanged` | The current track is added to or removed from Liked Songs. |
| `BufferingChanged` | Spotify finished buffering, e.g. shortly after a song change or seek. |
| `Ping` | Heartbeat every 30 s. Payload: `{ "timestamp": <ms> }`. |

Every event except `Ping` carries the complete state, so a receiver can always replace its state with the latest payload. Receivers should treat unknown event names as state updates if their payload looks like a state payload, and ignore them otherwise.

### State payload

```json
{
  "playerData": {
    "item": { "uri": "spotify:track:…", "name": "…", "artists": [ … ], "album": { … }, "metadata": { … } },
    "context": { "uri": "spotify:playlist:…", "metadata": { … } },
    "nextItems": [ … up to 5 … ],
    "previousItems": [ … up to 5 … ],
    "positionAsOfTimestamp": 45120,
    "timestamp": 1791499175054,
    "duration": 188453,
    "isPaused": false,
    "isBuffering": false,
    "shuffle": false,
    "repeat": 0,
    "restrictions": { "canPause": true, … }
  },
  "isPlaying": true,
  "volume": 0.8,
  "isMuted": false,
  "isHearted": true,
  "shuffle": false,
  "repeat": 0,
  "progress": 45120,
  "protocolVersion": 1,
  "extensionVersion": "0.4.0"
}
```

- `playerData` is Spotify's own `Spicetify.Player.data` (camelCase, may gain or lose fields with Spotify updates) with a live `positionAsOfTimestamp` and `timestamp`, and with the queue trimmed to 5 items. It is `null` while nothing is loaded.
- The top-level fields are maintained by the extension and are stable: `volume` is `0.0`–`1.0`, `progress` is in milliseconds, `repeat` uses the same values as `SetRepeat`. `isMuted` is `true` when the volume is 0.
- `protocolVersion` and `extensionVersion` are only sent with `InitialState`.

## Versioning and compatibility

- `protocolVersion` changes only for changes that receivers have to know about (removed or renamed fields, changed meaning). Adding requests, events, error codes or optional fields does not change it.
- Receivers should ignore fields they do not know.
- Extensions before protocol version 1 (v0.3.x and older) send no `protocolVersion`; treat a missing value as `0`. Version 0 additionally sent snake_case duplicates of some fields and the full queue.

| Extension | Protocol | Notes |
|---|---|---|
| 0.4.0 | 1 | Error codes, `BufferingChanged`, `protocolVersion` / `extensionVersion` in `InitialState`. |
| ≤ 0.3.x | 0 | No error codes, no version information. |
