# Windows Media Integration Architecture (Sprint 3)

This document details the existing Windows System Media and Volume integration in `nocturne-connector` for My-Turne.

## Overview

The Windows Connector integrates natively with Windows System Media via Global System Media Transport Controls (`GSMTC` / `GlobalSystemMediaTransportControlsSessionManager`) and Windows Audio Endpoint APIs (`IAudioEndpointVolume`).

The runtime data flow for media metadata and events is:

```text
Windows APIs (GSMTC & IAudioEndpointVolume)
    ↓ Native Windows Host Bridge (windows/src-tauri/src/native/media.rs)
Named Pipe / Bridge Server (MessagePack IPC)
    ↓ SystemMediaService (src/server/services/system-media-service.ts)
NocturneManager (src/server/nocturne-manager.ts)
    ↓ Bluetooth / RFCOMM RPC
Car Thing UI (My-Turne / Nocturne UI)
```

## Media Control Separation & Routing

There is a distinction between device-facing RPC methods and native host-bridge calls:

- **Device-Facing RPC Methods**: Car Thing daemons call explicit methods such as `media.control.play`, `media.control.pause`, `media.control.next`, `media.control.previous`, `media.control.toggle`, `media.control.shuffle`, `media.control.repeat`, `media.control.volumeUp`, and `media.control.volumeDown`.
- **Native Host-Bridge RPC**: `SystemMediaService` maps device-facing methods onto a single native host bridge call `media.control` with an `{ action: string }` payload (`play`, `pause`, `stop`, `toggle`, `next`, `previous`, `shuffle`, `repeat`, `volume_up`, `volume_down`).

> **Routing Note for `my-turne`**: Currently in `my-turne`, UI media controls are hardcoded to route toward phone HID / Spotify. Directing media control actions to a connected Windows Connector requires a route-selection change in `my-turne`.

## Volume Control & Event Flow

The end-to-end master volume update flow is:

```text
Windows Audio Endpoint (IAudioEndpointVolume) / IMMNotificationClient
    ↓
Native Windows Host Bridge emits `device.volume.update` ({ volume_percent, muted })
    ↓
SystemMediaService receives event and updates cache
    ↓
NocturneManager queues and calls daemon `device.volume.update` RPC ({ volume_percent, muted })
    ↓
Daemon translates into UI `phone.volume.update` event
```

> **Daemon Compatibility Note**: The current Car Thing daemon processes `volume_percent` from `device.volume.update` but currently drops `muted`. Master volume adjustments work end-to-end, while full mute presentation in the UI requires daemon-side handling of `muted`.

### Volume RPC Methods

| RPC Method | Parameters | Description |
| --- | --- | --- |
| `volume.get` / `media.get_volume` | `{}` | Returns current master volume `{ volume_percent, muted }` |
| `volume.set` / `media.set_volume` | `{ volume_percent: number }` | Sets master volume to bounded 0–100% |
| `volume.adjust` / `media.adjust_volume` | `{ delta: number }` | Adjusts master volume by delta percentage |
| `volume.toggleMute` / `volume.toggle_mute` | `{ muted?: boolean }` | Toggles or explicitly sets mute state |

## GSMTC Session Handling & Spotify Filtering

1. **GSMTC Current Session**:
   - The native host polls `GlobalSystemMediaTransportControlsSessionManager.GetCurrentSession()`.
   - It monitors the currently active system media session provided by Windows.
2. **Spotify Filtering Policy**:
   - **Spotify Linked**: When a Spotify account is linked in Nocturne, direct Spotify API/WebSocket integration owns Spotify playback. If `GetCurrentSession()` returns a Spotify source, the native host/Connector suppresses those media events without switching to another media player session.
   - **Spotify Skipped / Unlinked**: When Spotify is skipped or unlinked, GSMTC handles all system media sources, including Spotify desktop, web browser playback, and local media applications. `SystemMediaService` remains forced active while Spotify is marked skipped (`spotify-skipped.json`).

## Events Broadcasted to Car Thing

| Event Topic | Payload Shape | Description |
| --- | --- | --- |
| `media.now_playing.update` | `{ media_item_attributes, playback_attributes, media_generation }` | Broadcasts current track metadata, duration, playback status, app name, and projected elapsed time |
| `media.now_playing.artwork` | `{ data: string, content_type: "image/jpeg", media_generation: number }` | Base64 JPEG artwork scaled to max 300px |

> **Note on Volume Communication**: Volume changes from the Windows audio endpoint are sent to the daemon as a `device.volume.update` RPC call (rather than a broadcast event topic), which the daemon then converts into a `phone.volume.update` event for the Car Thing UI.

## Payload Casing & Compatibility

- Canonical outgoing wire fields use `snake_case` (`media_item_attributes`, `playback_attributes`, `media_generation`, `volume_percent`).
- `SystemMediaService.normalizeNowPlayingUpdate` accepts both legacy `camelCase` and canonical `snake_case` inputs from native bridges.

## Replay & Timeline Rebase

- Upon Car Thing connection or UI replay requests, `SystemMediaService.replayLatest()` rebases playing track progress (`PlaybackElapsedTimeInMilliseconds`) based on `PlaybackRate` and elapsed time since update emission, ensuring track progress is accurately displayed on the Car Thing without moving backward.

## Validation Checklist & Gap Analysis

When testing My-Turne integration with the Windows Connector:

- [ ] **Browser Media**: Play audio/video in Chrome/Edge/Firefox. Verify track title, artist, play/pause state, and timeline updates reach the Car Thing.
- [ ] **Desktop Media Players**: Play media in a native Windows player (e.g., Windows Media Player / Foobar2000 / VLC). Verify metadata, artwork, and playback controls (`media.control.*`).
- [ ] **Spotify Desktop (Unlinked / Skipped)**: Verify Spotify desktop playback appears via GSMTC when Spotify account is skipped/unlinked in Connector.
- [ ] **Spotify Desktop (Linked)**: Verify GSMTC suppresses Spotify system media events when Spotify account is linked.
- [ ] **Volume Controls**: Trigger volume adjustment from Car Thing and Windows system tray. Confirm `device.volume.update` RPC call updates master volume on Windows and daemon.
- [ ] **Cross-Repo Gap (`my-turne`)**: Ensure `my-turne` daemon routes media RPC calls to Windows when Windows Connector is selected over Phone HID.
