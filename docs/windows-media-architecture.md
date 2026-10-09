# Windows Media Integration Architecture (Sprint 3)

This document details the Windows System Media and Volume integration in `nocturne-connector` for My-Turne.

## Overview

The Windows Connector integrates natively with Windows System Media via Global System Media Transport Controls (`GSMTC` / `GlobalSystemMediaTransportControlsSessionManager`) and Windows Audio Endpoint APIs (`IAudioEndpointVolume`).

The runtime data flow for media metadata, volume, and control commands is:

```text
Windows APIs (GSMTC & IAudioEndpointVolume)
    ↓ Native Windows Host Bridge (windows/src-tauri/src/native/media.rs)
Named Pipe / Bridge Server (MessagePack IPC)
    ↓ SystemMediaService (src/server/services/system-media-service.ts)
NocturneManager (src/server/nocturne-manager.ts)
    ↓ Bluetooth / RFCOMM (RPC Calls & Events)
Car Thing Daemon / UI (My-Turne / Nocturne)
```

## RPC Methods vs. Broadcast Events Terminology

The Connector distinguishes between **RPC calls** (request-response invocations) and **broadcast events** (one-way topic broadcasts over RFCOMM):

1. **Broadcast Events (Connector → Car Thing)**:
   - `media.now_playing.update`: One-way event containing track metadata (`media_item_attributes`), playback status, app name, playback rate, and timeline position (`playback_attributes`), correlated with `media_generation`.
   - `media.now_playing.artwork`: One-way event containing Base64-encoded JPEG artwork (max 300px), correlated with `media_generation`.

2. **Device-Facing RPC Methods (Car Thing → Connector)**:
   - `media.control.play`, `media.control.pause`, `media.control.stop`, `media.control.next`, `media.control.previous` (and alias `media.control.prev`), `media.control.toggle` (and aliases `media.control.playPause`, `media.control.togglePlayPause`), `media.control.shuffle`, `media.control.repeat`, `media.control.volumeUp` (or `media.control.volume_up`), `media.control.volumeDown` (or `media.control.volume_down`), `media.control.like`, `media.control.unlike`.
   - `volume.get` (or `media.get_volume`), `volume.set` (or `media.set_volume`), `volume.adjust` (or `media.adjust_volume`), `volume.toggleMute` (or `volume.toggle_mute`, `volume.mute`).

3. **Outgoing Device RPC Method (Connector → Car Thing Daemon)**:
   - `device.volume.update`: Outgoing RPC call from Connector to the Car Thing daemon carrying `{ volume_percent: number, muted?: boolean }`. The daemon handles this call and converts it into a local UI `phone.volume.update` event.

4. **Internal Host-Bridge RPC (SystemMediaService → Native Windows Host)**:
   - `media.control`: IPC request with `{ action: string }` mapping onto Windows GSMTC APIs or master volume steps (`play`, `pause`, `stop`, `toggle`, `next`, `previous`, `shuffle`, `repeat`, `volume_up`, `volume_down`).
   - `volume.get`, `volume.set`, `volume.adjust`, `volume.toggleMute`: IPC requests targeting Windows `IAudioEndpointVolume`.

## Volume Control & Event Flow

`app.ready.capabilities` is a snapshot taken at handshake time. Initial volume
discovery runs asynchronously on the existing shared host bridge, so `volume`
remains false until a valid probe response, volume event, or volume RPC verifies
support. Call the canonical `connector.capabilities` RPC to query current status;
it returns `{ capabilities: { volume, media, discord, systemStats, macros, appLaunch } }`
from cached state without another native-host probe. Media activation and volume
support are independent, including when system media is disabled at startup.

The master volume update flow is:

```text
Windows Audio Endpoint (IAudioEndpointVolume) / IMMNotificationClient
    ↓ (Native host emits `device.volume.update` IPC event)
SystemMediaService updates volume cache & deduplicates state
    ↓
NocturneManager queues and calls daemon `device.volume.update` RPC ({ volume_percent, muted })
    ↓
Car Thing Daemon translates into UI `phone.volume.update` event
```

### Volume RPC Methods

| RPC Method | Parameters | Return Shape | Description |
| --- | --- | --- | --- |
| `volume.get` / `media.get_volume` | `{}` | `{ volume_percent: number, muted: boolean }` | Gets Windows master volume scalar and mute state |
| `volume.set` / `media.set_volume` | `{ volume_percent: number }` | `{ status: "ok", volume_percent: number, muted: boolean }` | Sets Windows master volume scalar (bounded 0–100%) |
| `volume.adjust` / `media.adjust_volume` | `{ delta: number }` | `{ status: "ok", volume_percent: number, muted: boolean }` | Adjusts master volume by integer delta percentage |
| `volume.toggleMute` / `volume.toggle_mute` | `{ muted?: boolean }` | `{ status: "ok", volume_percent: number, muted: boolean }` | Toggles or explicitly sets master mute state |

> **Daemon Compatibility Note**: The current Car Thing daemon processes `volume_percent` from `device.volume.update` but currently ignores the `muted` field. Master volume adjustments work end-to-end, while full mute presentation in the UI requires daemon-side handling of `muted`.

## Supported Host Actions & Known Limitations

| Device RPC Method | Native Host Action | GSMTC / Audio API Target | Status & Limitations |
| --- | --- | --- | --- |
| `media.control.play` | `play` | `TryPlayAsync()` | Supported |
| `media.control.pause` | `pause` | `TryPauseAsync()` | Supported |
| `media.control.stop` | `stop` | `TryStopAsync()` | Supported |
| `media.control.next` | `next` | `TrySkipNextAsync()` | Supported |
| `media.control.previous` | `previous` | `TrySkipPreviousAsync()` | Supported |
| `media.control.toggle` | `toggle` | `TryTogglePlayPauseAsync()` | Supported |
| `media.control.shuffle` | `shuffle` | `TryChangeShuffleActiveAsync()` | Supported (toggles active shuffle) |
| `media.control.repeat` | `repeat` | `TryChangeAutoRepeatModeAsync()` | Supported (cycles None → List → Track) |
| `media.control.volumeUp` | `volume_up` | `IAudioEndpointVolume` step (+6.25%) | Supported (works even with no active media session) |
| `media.control.volumeDown` | `volume_down` | `IAudioEndpointVolume` step (-6.25%) | Supported (works even with no active media session) |
| `media.control.like` / `unlike` | `like` / `unlike` | N/A | Returns `{ status: "unsupported" }` (GSMTC lacks a standard track rating API) |

### Session & Fallback Behavior

- When no active Windows media session is running, transport control methods (`play`, `pause`, `next`, `previous`, `toggle`) return `{ status: "unsupported" }` gracefully.
- Master volume controls (`volume.set`, `volume.adjust`, `volume.toggleMute`, `media.control.volumeUp`, `media.control.volumeDown`) operate directly against Windows `IAudioEndpointVolume` and function independently of active media sessions.

## GSMTC Session Handling & Spotify Filtering Policy

1. **GSMTC Active Session Monitoring**:
   - The native host queries `GlobalSystemMediaTransportControlsSessionManager.GetCurrentSession()` to monitor the single active system media session designated by Windows (rather than tracking every background media session simultaneously).
   - Any playing audio application currently surfaced as the active session by Windows GSMTC (browser, desktop player, media service) streams metadata and artwork to the Connector.
2. **Spotify Filtering Policy**:
   - **Spotify Linked**: When a Spotify account is linked in Nocturne/Connector, direct Spotify Web API + WebSocket integration handles Spotify playback. If `GetCurrentSession()` reports a Spotify source, GSMTC media events are suppressed to prevent duplicate metadata or state collisions.
   - **Spotify Skipped / Unlinked**: When Spotify is skipped or unlinked, GSMTC handles all system media sources, including Spotify desktop, web browsers, and local players. `SystemMediaService` remains forced active while Spotify is marked skipped (`spotify-skipped.json`).

## Replay & Timeline Rebase on Reconnect

- Upon Car Thing connection or UI ready handshake (`app.ready`), `SystemMediaService.replayLatest()` rebases playing track progress (`PlaybackElapsedTimeInMilliseconds`) based on `PlaybackRate` and elapsed time since update emission:
  $$\text{projected\_ms} = \text{elapsed\_ms} + (\text{now\_ms} - \text{received\_at\_ms}) \times \text{playback\_rate}$$
- Bounded by track duration. Paused tracks are not projected. Artwork is re-emitted if its generation matches the active now-playing update.

## `my-turne` Integration Requirement

> **Cross-Repo Requirement (`my-turne`)**:
> While Windows master volume RPCs (`volume.get`, `volume.set`, `volume.adjust`, `volume.toggleMute`, `media.control.volumeUp`, `media.control.volumeDown`) and transport control RPCs (`media.control.*`) are fully implemented in the Connector to target Windows `IAudioEndpointVolume` and GSMTC, directing Car Thing UI volume knob actions, physical media buttons, or UI widgets to those Connector RPCs requires `my-turne` routing changes:
> 1. `my-turne` must select the Windows Connector as its active media controller when connected to Windows.
> 2. `my-turne` daemon must forward UI volume dial actions and media button presses as `volume.*` or `media.control.*` RPC calls to the Windows Connector.

## Hardware Validation Checklist

Use this checklist when validating physical or virtual Car Thing hardware connected to the Windows Connector:

- [ ] **Chrome / Edge / Firefox Media**: Play audio or video (e.g. YouTube, Soundcloud) in a browser. Confirm track title, artist, play/pause status, and projected timeline appear on Car Thing.
- [ ] **Native Windows Player**: Play audio in VLC, Windows Media Player, or Foobar2000. Confirm track metadata, album artwork (JPEG max 300px), and play/pause/skip controls work.
- [ ] **Spotify Desktop (Unlinked / Skipped)**: Play media in Spotify Desktop with Spotify account unlinked/skipped in Connector. Confirm track updates arrive via GSMTC.
- [ ] **Spotify Desktop (Linked)**: Link Spotify in Connector. Confirm GSMTC suppresses Spotify system media events while Spotify direct API/WS integration takes over.
- [ ] **Master Volume Controls**: Change volume from Car Thing dial and Windows system tray. Confirm `volume.set` and `device.volume.update` bidirectional sync works.
- [ ] **No Media Session Fallback**: Close all media players. Confirm volume controls continue working and transport controls return `unsupported` without crashing.
- [ ] **Device Reconnect**: Disconnect and reconnect Bluetooth RFCOMM. Confirm `replayLatest()` instantly restores current track metadata, artwork, and rebased progress on Car Thing.
