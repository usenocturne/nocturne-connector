# Windows Media Integration Architecture (Sprint 3)

This document details the existing Windows System Media and Volume integration in `nocturne-connector` for My-Turne.

## Overview

The Windows Connector integrates natively with Windows System Media via Global System Media Transport Controls (`GSMTC` / `GlobalSystemMediaTransportControlsSessionManager`) and Windows Audio Endpoint APIs (`IAudioEndpointVolume`).

The runtime data flow is:

```text
Windows APIs (GSMTC & IAudioEndpointVolume)
    ↓ Native Windows Host Bridge (windows/src-tauri/src/native/media.rs)
Named Pipe / Bridge Server (MessagePack IPC)
    ↓ SystemMediaService (src/server/services/system-media-service.ts)
NocturneManager (src/server/nocturne-manager.ts)
    ↓ Bluetooth / RFCOMM RPC
Car Thing UI (My-Turne / Nocturne UI)
```

## Existing Media RPC Methods

The native Windows connector and backend RPC dispatcher support the following methods out-of-the-box.

### Volume Controls

| RPC Method | Parameters | Description |
| --- | --- | --- |
| `volume.get` / `media.get_volume` | `{}` | Returns current master volume `{ volume_percent, muted }` |
| `volume.set` / `media.set_volume` | `{ volume_percent: number }` | Sets master volume to bounded 0–100% |
| `volume.adjust` / `media.adjust_volume` | `{ delta: number }` | Adjusts master volume by delta percentage |
| `volume.toggleMute` / `volume.toggle_mute` | `{ muted?: boolean }` | Toggles or explicitly sets mute state |

### Media Controls

Methods called via `media.control.<action>` or `media.control` RPC:

| RPC Method / Action | Target Action | Description |
| --- | --- | --- |
| `media.control.play` | `play` | TryPlayAsync on current media session |
| `media.control.pause` | `pause` | TryPauseAsync on current media session |
| `media.control.stop` | `stop` | TryStopAsync on current media session |
| `media.control.toggle` / `playPause` / `togglePlayPause` | `toggle` | TryTogglePlayPauseAsync on current media session |
| `media.control.next` | `next` | TrySkipNextAsync on current media session |
| `media.control.previous` / `prev` | `previous` | TrySkipPreviousAsync on current media session |
| `media.control.shuffle` | `shuffle` | Toggles shuffle mode |
| `media.control.repeat` | `repeat` | Cycles auto repeat mode (off -> list -> track) |
| `media.control.volumeUp` / `volume_up` | `volume_up` | Steps master volume up |
| `media.control.volumeDown` / `volume_down` | `volume_down` | Steps master volume down |

## Events Broadcasted to Car Thing

| Event Topic | Payload Shape | Description |
| --- | --- | --- |
| `media.now_playing.update` | `{ media_item_attributes, playback_attributes, media_generation }` | Broadcasts current track metadata, duration, playback status, app name, and projected elapsed time |
| `media.now_playing.artwork` | `{ data: string, content_type: "image/jpeg", media_generation: number }` | Base64 JPEG artwork scaled to max 300px |
| `device.volume.update` | `{ volume_percent: number, muted: boolean }` | Master volume / mute state changes from native notifications or RPC actions |

## Payload Casing & Compatibility

- Canonical outgoing wire fields use snake_case (`media_item_attributes`, `playback_attributes`, `media_generation`, `volume_percent`).
- `SystemMediaService.normalizeNowPlayingUpdate` accepts both legacy camelCase and canonical snake_case inputs from native bridges.

## Spotify Integration & Filtering Policy

1. **Spotify Linked**:
   - When a Spotify account is linked, Spotify desktop playback is handled directly via Spotify Connect / Spotify API.
   - GSMTC system media events originating from `Spotify` are suppressed by `SystemMediaService` to avoid duplicating linked Spotify state on the UI.
2. **Spotify Skipped / Unlinked**:
   - When Spotify is skipped or not linked, GSMTC handles all media sources including Spotify desktop, browser playback, and local media players.
   - `SystemMediaService` remains forced active while Spotify is skipped (`spotify-skipped.json`).

## Replay & Timeline Rebase

- Upon Car Thing connection or UI replay requests, `SystemMediaService.replayLatest()` rebases playing track progress (`PlaybackElapsedTimeInMilliseconds`) based on the `PlaybackRate` and elapsed time since update emission, ensuring progress is accurately reflected on the Car Thing without jumping backward.
