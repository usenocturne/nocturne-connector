# Jules Implementation Plan: My-Turne Native Windows Connector

## Project Goal

Extend a fork of `usenocturne/nocturne-connector` so My-Turne can use Nocturne's existing native Windows Bluetooth/RFCOMM transport for Windows-specific features.

This replaces the failed direct-LAN Windows Companion architecture.

The desired runtime is:

```text
Windows available:

Car Thing UI
    ↓ local Nocturne WebSocket
Nocturne daemon
    ↓ Bluetooth / RFCOMM RPC
My-Turne Windows Connector
    ↓ native Windows bridge
Windows APIs
```

```text
Windows unavailable:

Car Thing
    ↓ Bluetooth / RFCOMM
Mac Nocturne Connector
    ↓
Normal Nocturne / Spotify behavior
```

Windows should be preferred when its Connector is healthy. The Mac Connector remains the fallback.

---

# Repository Boundary

This repository is the Connector side of My-Turne.

Recommended fork:

```text
usenocturne/nocturne-connector
          ↓
alexliu4/my-turne-connector
```

The existing `alexliu4/my-turne` repo remains the Car Thing / daemon / UI side.

Do not copy the Connector source into `my-turne`.

## `my-turne-connector` owns

- Windows Bluetooth/RFCOMM Connector behavior
- Windows native host bridge
- Windows media integration
- Windows volume integration
- Discord integration
- PC/system stats
- macros
- app launching
- other Windows-host features

## `my-turne` owns

- Car Thing UI
- Car Thing daemon
- connector route selection / Windows preference
- device-side RPC calls
- device-native features

Cross-repo work is allowed conceptually, but each PR should normally change only one repo.

---

# Non-Negotiable Architecture Rules

## 1. Reuse the native Windows Connector

Do not recreate:

- `crates/windows-companion`
- a second WebSocket server
- direct Car Thing → Windows LAN transport
- a Mac TCP proxy
- a Mac RPC → Windows relay

The native Windows Connector already owns the physical connection.

## 2. Preserve upstream Bluetooth behavior

Do not unnecessarily rewrite:

- Windows RFCOMM pairing
- channel selection
- reconnect behavior
- Bluetooth discovery
- authentication
- native bridge lifecycle
- tray/autostart behavior

Relevant existing areas include:

```text
src/server/platform/windows/bluetooth.ts
src/server/services/bluetooth-service.ts
windows/src-tauri/src/native/bluetooth.rs
windows/src-tauri/src/bridge/
windows/src-tauri/src/host/
windows/src-tauri/src/lib.rs
```

## 3. Keep compatibility with existing Nocturne

Current upstream intentionally sends:

```text
app.ready.platform = "web"
```

even on Windows for released-firmware compatibility.

Do not change that field to `"windows"`.

Add separate optional metadata if My-Turne needs to identify a Windows Connector.

## 4. Reuse existing Windows media infrastructure

Before adding Windows media or volume code, inspect and reuse:

```text
src/server/services/system-media-service.ts
src/server/nocturne-manager.ts
windows/src-tauri/src/native/media.rs
```

Upstream already supports:

- Windows system media sessions
- media state/events
- media controls
- artwork
- volume reporting
- volume up/down
- Windows native audio endpoint access

Do not create a second competing media/volume subsystem.

## 5. Keep upstream mergeability high

Prefer small extensions over broad rewrites.

Avoid:

- renaming upstream concepts without need
- moving large upstream directories
- generic plugin frameworks
- premature provider abstractions
- unrelated formatting churn
- changing Linux/macOS behavior for a Windows-only feature

Every Windows-specific shared-code seam should preserve existing non-Windows behavior.

---

# Sprint 0 — Fork, Build, and Baseline Windows Validation

## Goal

Prove the stock upstream Windows Connector works on the target Windows PC before My-Turne-specific modifications.

This sprint should contain little or no product code.

## Tasks

1. Fork:

```text
usenocturne/nocturne-connector
```

into the My-Turne Connector repository.

2. Configure upstream tracking so future upstream changes can be merged cleanly.

3. Build/check the current Windows Connector using the repository's existing workflows.

Relevant commands include:

```bash
just windows-check
just windows-test
```

For a Windows distributable/local build, use the existing Windows build workflow rather than inventing another launcher.

4. Run the Connector on the Windows PC.

5. Pair/connect the Car Thing using the existing Nocturne Windows flow.

6. Verify with **no USB data cable**:

- Car Thing connects to Windows over Bluetooth/RFCOMM
- normal Nocturne RPC works
- Spotify / normal supported behavior remains usable
- Connector reconnects after a temporary disconnect
- Windows background/tray behavior remains functional

7. Record the exact local development/build/run workflow in:

```text
docs/my-turne-windows-dev.md
```

Keep it concise and reproducible.

## Acceptance Criteria

- stock fork builds/checks successfully
- Car Thing communicates with Windows wirelessly
- no custom LAN/WebSocket transport is involved
- no USB data cable is required for normal operation
- no My-Turne feature work has started yet

## Stop Condition

If the stock Windows Connector cannot reliably pair/connect to the target Car Thing, stop here and debug upstream/native Windows connectivity first.

Do not begin feature implementation on top of an unverified transport.

---

# Sprint 1 — Explicit Windows Connector Identity

## Goal

Give the `my-turne` daemon a safe way to recognize a Windows Connector without changing compatibility-sensitive fields.

Current upstream sends:

```ts
app.ready = {
  platform: "web",
  ...
}
```

That must remain intact.

## Requirements

Add minimal optional Connector identity metadata to `app.ready`.

Preferred shape, if it fits current naming conventions:

```ts
{
  platform: "web",
  connectorPlatform: "windows"
}
```

Alternative naming is acceptable if existing protocol conventions clearly favor another name.

Requirements:

- emit the field only when useful
- preserve `platform: "web"`
- old Car Thing daemons must safely ignore the extra field
- Linux/Pi defaults must not change
- macOS behavior must not accidentally become Windows behavior
- add focused tests around `app.ready`

Do not implement route priority in this repo.

Route selection belongs in `alexliu4/my-turne`.

## Cross-Repo Dependency

After this PR is ready, `my-turne` should add:

```text
if a healthy route advertises Windows Connector identity:
    prefer it
else:
    preserve existing surviving-route behavior
```

The Connector repo should not duplicate that state machine.

## Acceptance Criteria

A connected Windows Connector produces an `app.ready` payload that can be unambiguously recognized as Windows while preserving all existing compatibility fields.

---

# Integration Checkpoint — Windows Preferred, Mac Fallback

This is a cross-repo physical validation checkpoint, not necessarily a Connector code sprint.

Do not continue to host-feature development until it passes.

## Required behavior

With both Connectors available:

```text
Windows Connector → preferred
Mac Connector     → fallback
```

Test:

1. Start Mac Connector.
2. Start Windows Connector.
3. Confirm the Car Thing selects Windows.
4. Stop Windows Connector.
5. Confirm the Mac route becomes usable without breaking Nocturne.
6. Restart Windows Connector.
7. Confirm Windows becomes preferred again.
8. Test a Windows sleep/wake or Bluetooth interruption.
9. Confirm stale routes are not left active.
10. Confirm Spotify/core Nocturne behavior survives transitions.

## Acceptance Criteria

The device can move:

```text
Windows → Mac → Windows
```

without USB and without manual Car Thing recovery.

Only after this passes should the Windows feature roadmap resume.

---

# Sprint 2 — Windows Volume RPC

## Goal

Implement the first My-Turne-specific Windows control using the existing native media/audio stack.

Do not port the old standalone Windows Companion volume implementation verbatim.

## Existing Upstream Functionality to Reuse

Inspect:

```text
src/server/services/system-media-service.ts
src/server/nocturne-manager.ts
windows/src-tauri/src/native/media.rs
```

Current upstream already has:

- current volume reporting
- `device.volume.update`
- native `IAudioEndpointVolume`
- volume up/down control
- media control routing

Extend this rather than creating `VolumeManager` or another Windows audio backend.

## Desired My-Turne Operations

Support, where practical:

```text
volume.get
volume.set
volume.adjust
volume.toggleMute
```

or equivalent RPC names that fit the existing Nocturne RPC naming conventions.

Prefer explicit RPC methods over a generic stringly-typed `host.action` envelope if the current Connector architecture naturally supports named methods.

## Requirements

- get current master output volume
- set master volume to a bounded percentage
- adjust by a requested delta
- mute/unmute or toggle mute
- propagate volume/mute state changes to Car Thing
- survive default audio-device changes
- fail safely if the Windows audio endpoint is unavailable

Avoid polling faster than necessary if native notifications/state already cover the requirement.

## Tests

Add focused tests for:

- clamping volume
- malformed/out-of-range requests
- unsupported/unavailable audio endpoint behavior
- mute state serialization
- existing media controls remain unchanged

Do not add broad unrelated Windows tests.

## Acceptance Criteria

From the Car Thing through native Connector RPC, with no USB:

- read Windows volume
- set Windows volume
- adjust Windows volume
- toggle mute
- receive updated state

---

# Sprint 3 — Windows Media for My-Turne

## Goal

Expose Windows system media cleanly to a dedicated My-Turne UI without rebuilding functionality upstream already has.

## Existing Upstream Functionality

The Connector already supports Windows system media session handling including:

- source application
- title
- artist
- album
- playback state
- artwork
- timeline/progress
- play/pause
- next/previous
- additional media controls
- media generation/order handling

Before adding code, map exactly which existing RPCs/events the Car Thing already receives.

## Tasks

1. Document reusable existing methods/events.
2. Add only missing RPC/event pieces required by the My-Turne Windows Media screen.
3. Preserve Spotify-specific behavior and the existing rule that Windows system media should not duplicate linked Spotify unnecessarily.
4. Do not create a second polling loop if `WindowsMediaState` already provides the needed state.

## Acceptance Criteria

My-Turne can build its Windows Media UI using the native Connector's media state with minimal new Connector code.

Works with at least:

- browser media
- a Windows media player
- Spotify desktop when it is appropriate for the existing system-media mode

---

# Sprint 4 — Connector Capability Metadata

## Goal

Expose which optional My-Turne host features are actually supported by the connected Windows build.

This replaces the old standalone `HostCapability` WebSocket handshake concept.

## Requirements

Add a small capability representation compatible with existing Connector RPC/events.

Initial candidate capabilities:

```text
volume
media
discord
systemStats
macros
appLaunch
```

Do not build a plugin SDK.

The purpose is only to let the Car Thing say:

```text
Volume       Available
Media        Available
Discord      Unavailable
```

Capabilities should reflect real compiled/runtime support.

Do not advertise a capability before its backing implementation is usable.

## Acceptance Criteria

Car Thing can query or receive current Windows feature availability through the existing native Connector path.

---

# Sprint 5 — Discord Integration

## Goal

Add Discord-specific controls without affecting core Connector reliability.

## Scope

Start small:

- Discord availability/running state
- mute state if obtainable reliably
- toggle mute
- optionally deafen state/toggle after mute is stable

## Requirements

Before coding, inspect which local Discord integration path is reliable and maintainable.

Prefer:

- documented/local IPC or supported APIs where available
- bounded failure handling
- no UI scraping
- no global keyboard automation as the primary integration unless explicitly chosen as a fallback

Keep Discord failures isolated from Bluetooth, Spotify, and media.

## Acceptance Criteria

When Discord is unavailable, Connector remains fully healthy.

When Discord is available, My-Turne can read/toggle the supported state through normal Connector RPC.

---

# Sprint 6 — Windows System Stats

## Goal

Expose lightweight PC telemetry.

Initial data:

```text
CPU usage
memory usage
optional GPU usage
```

## Requirements

- low sampling overhead
- bounded update rate
- no high-frequency Bluetooth spam
- cache latest values
- send updates only at a useful UI cadence
- optional capability if a metric cannot be obtained reliably

Avoid large monitoring frameworks.

## Acceptance Criteria

Car Thing can display stable system stats without measurable disruption to media/RPC responsiveness.

---

# Sprint 7 — App Launching and Macros

## Goal

Add deliberate user-configured host actions.

## App Launching

Support configured applications rather than arbitrary remote shell execution.

Prefer identifiers/configured allowlists such as:

```text
VS Code
Discord
Browser
Steam
```

Do not expose a generic unauthenticated command shell over RPC.

## Macros

Start with constrained action types:

- launch configured app
- media action
- configured key shortcut
- configured URL
- other explicitly modeled local actions

Do not build a marketplace/plugin runtime.

## Acceptance Criteria

Configured actions execute reliably and invalid/unconfigured actions fail safely.

---

# Sprint 8 — Host Status and Feature Polish

## Goal

Make the Windows integration feel like a native part of My-Turne.

Most visible UI work belongs in `alexliu4/my-turne`, but the Connector must expose clean state.

Provide enough information for the device to show:

```text
Windows PC
Connected

Volume        Available
Media         Available
Discord       Available
System Stats  Available
Macros        Available
App Launch    Available
```

Offline/fallback behavior:

```text
Windows PC
Offline

Core Nocturne remains available through Mac Connector
```

Do not couple UI presentation details into Connector internals.

---

# Development / Validation Commands

Prefer existing project workflows.

Useful upstream commands include:

```bash
just windows-check
just windows-test
```

Before broad Windows changes, also use the repository's existing TypeScript/Bun checks and Rust tests relevant to the touched layer.

Do not introduce a parallel build system.

---

# PR Strategy

Keep PRs sequential and reviewable.

Recommended order:

```text
PR 1  baseline/fork docs if needed
PR 2  Windows connector identity
      ↓
      cross-repo Windows-preference PR in my-turne
      ↓
      physical Windows → Mac → Windows failover test
PR 3  volume RPC
PR 4  media gap-fill only
PR 5  capability metadata
PR 6  Discord
PR 7  system stats
PR 8  app launching/macros
```

Do not combine connector identity, route preference, volume, and Discord into one PR.

---

# Code Review Rules for Jules

For every sprint:

1. Read the existing implementation before adding a new abstraction.
2. Reuse native Windows host bridge/media/Bluetooth code.
3. Keep Windows-specific changes narrow.
4. Preserve Pi/macOS behavior.
5. Avoid generated-file churn unless generation is required.
6. Add only tests that protect the changed behavior.
7. Do not add speculative support for future transports.
8. Do not revive the old direct-LAN Windows Companion architecture.
9. Report any upstream functionality that makes a requested My-Turne implementation redundant.
10. If a sprint requirement is already substantially implemented upstream, reduce the PR instead of duplicating it.

---

# Architecture Failure Context

The previous My-Turne design used:

```text
Car Thing UI
    ↓ direct LAN WebSocket
custom Windows Companion
```

Physical testing showed the Car Thing had only:

```text
uncm0: 10.42.1.218/29
route: 10.42.1.216/29 dev uncm0
```

and no default/home-LAN route.

Both Windows:

```text
192.168.1.175
```

and Mac:

```text
192.168.1.188
```

returned:

```text
Network is unreachable
```

from the Car Thing.

A raw Mac TCP proxy was technically functional but unusable because the Car Thing could not route to the Mac's LAN address without the development/USB network.

Do not attempt to solve this Connector plan with:

- LAN NAT
- Mac proxying
- USB networking
- direct browser WebSockets to Windows

The selected solution is to use Nocturne's already-supported Bluetooth/RFCOMM Windows Connector.

---

# Definition of Success

The architecture is successful when:

```text
Windows on:
Car Thing → Windows Connector → Windows features

Windows off:
Car Thing → Mac Connector → normal Nocturne

Windows returns:
Car Thing automatically prefers Windows again
```

with:

- no USB data cable
- no direct Car Thing LAN dependency
- no custom Windows Companion transport
- minimal divergence from upstream Nocturne Connector
- Windows features implemented through the existing native Connector stack
