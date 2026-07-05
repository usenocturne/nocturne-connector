# NOCTURNE-CONNECTOR — RASPBERRY PI Wi-Fi BRIDGE + SETUP UI

**Generated:** 2026-05-05
**Runtime (server):** Bun + TypeScript + Elysia
**Runtime (UI):** Vite + React 19 + Tailwind 4 + Radix UI
**Image:** Alpine-based, A/B rootfs with U-Boot fallback, built via `raspi-alpine`-style scripts
**Related repos:** `nocturned` (the daemon on the Car Thing this bridges Spotify auth + BT to), `nocturne-ui` (the kiosk UI on the Car Thing — independent), `nocturne-image` (firmware that pairs with this device).

## OVERVIEW

A flashable Raspberry Pi OS image (~60 MB) that gives the Car Thing internet by USB-tethering Wi-Fi from the Pi, while running a local web UI at `http://nocturne-connector.local` for:

1. **Initial setup wizard** (Wi-Fi, account login, BT pair the Car Thing)
2. **Spotify account linking** (OAuth callback handling)
3. **Bridge RPC** between phone/cloud services and the Car Thing
4. **Connector self-updates** (Settings UI checks GitHub release rootfs update assets and flashes the inactive A/B slot)

The Pi acts as a controller box; the Car Thing remains the primary user-facing device.

## STRUCTURE

```
nocturne-connector/
├── README.md
├── LICENSE                       # Apache (NOT GPL — separate from firmware repos)
├── Justfile                      # connector-api, run, lint, docker-qemu
├── build.sh                      # Top-level builder — produces output/*.img.gz + *_update.img.gz
├── wpa_supplicant.conf           # Default Wi-Fi config baked into image (user edits before flash)
├── scripts/
├── resources/                    # Image-build assets
├── cache/                        # Build cache (gitignored)
├── output/                       # Final flashable image + rootfs self-update image and .sha256 files
├── macos/                        # Native macOS port of the connector (see "MACOS APP" below)
└── src/                          # The actual Bun application — gets baked into the Pi rootfs
    ├── package.json              # bun + vite + elysia + react + dbus-next + supabase-js
    ├── bunfig.toml
    ├── tsconfig.json
    ├── vite.config.ts            # Frontend build → src/dist/client/
    ├── components.json           # Radix UI / shadcn config
    ├── server/
    │   ├── index.ts              # Elysia entrypoint: REST /api/* + WS /ws (topic "events")
    │   ├── nocturne-manager.ts   # CORE orchestrator — RPC bridge + event broadcast
    │   ├── routes/
    │   │   ├── auth.ts           # /api/auth — Supabase OTP, sign-in, callbacks
    │   │   ├── spotify.ts        # /api/spotify — link/disconnect Spotify accounts
    │   │   ├── info.ts           # /api/info — version, OS
    │   │   ├── setup.ts          # /api/setup — onboarding state machine
    │   │   ├── ota.ts            # /api/ota — connector self-update check/start/status
    │   │   └── power.ts          # /api/power — reboot / shutdown
    │   ├── services/
    │   │   ├── auth-service.ts
    │   │   ├── spotify-service.ts
    │   │   ├── bluetooth-service.ts   # dbus-next → BlueZ (BT pair the Car Thing)
    │   │   ├── ota-service.ts
    │   │   └── analytics-service.ts
    │   ├── rpc/                  # Type-safe RPC client/server primitives
    │   └── utils/
    │       ├── logger.ts
    │       ├── encryption.ts
    │       └── version.ts
    └── client/                   # React UI (built into src/dist/client/)
        ├── main.tsx
        ├── App.tsx               # Router + theme provider
        ├── pages/                # SetupWizard.tsx, Dashboard.tsx, SpotifyAuth.tsx, ...
        ├── components/           # Layout.tsx, ThemeProvider.tsx, ui/* (Radix wrappers)
        └── hooks/                # useAuth, useWebSocket, ...
```

## MACOS APP (`macos/`)

A native SwiftUI port of this connector (`Nocturne.xcodeproj`, single target
`Nocturne`, bundle id `com.usenocturne.nocturne`) that replaces the Pi: same
internal Spotify APIs, same RPC/chunking wire format, Bluetooth Classic RFCOMM
via IOBluetooth. Build with
`xcodebuild -project Nocturne.xcodeproj -scheme Nocturne build` (automatic
signing — do NOT disable code signing; the stable signature keeps TCC/keychain
grants). Behavior notes:

- **Menu bar app + launch at login.** Registers itself as a login item by
  default on first run (`SMAppService.mainApp`, toggle in Settings → Startup).
  Once setup is complete, every launch is background-only: no window, accessory
  activation policy, menu bar icon (dimmed = disconnected). The window opens
  from the menu bar panel or by reopening the app; closing it returns the app
  to menu-bar-only. The connector must keep running windowless. Reconnection is
  probe-first: the daemon opens a short RFCOMM probe to the Mac's
  Bluetooth-Incoming-Port listener on channel `3`. The Mac responds to that inbound
  probe by dialing the Car Thing's SPP/RPC channel `2`. macOS can report only the
  baseband ACL as "Connected" before the probe callback arrives; in that exact
  paired-Car-Thing/no-RFCOMM state, the Mac may make a bounded channel-2 fallback
  like the Pi connector. Do not add background sweeps of paired Car Things.
- **Pairing is never app-driven** — users pair in System Settings → Bluetooth;
  the app only watches the bond list and manages RFCOMM to bonded Car Things.
- **Links self-heal.** Two consecutive missed keep-alive pings (15s apart, 30s
  RPC timeout) tear the link down — including the baseband ACL — and then wait
  for the next Car Thing probe. This recovers channels whose close was never
  delivered (Mac sleep, abrupt device power-off) without the Mac polling the Car
  Thing address. RFCOMM data/close callbacks must match the stored channel
  object before they ingest bytes or detach RPC; stale duplicate channel-2
  callbacks can share the same address/channel key as the live link.
- **Auth must survive overnight network flaps.** The Supabase session JWT is
  refreshed ahead of expiry and on demand (with a forced retry on PostgREST
  401); only a definitive token rejection signs out — never a network error.
  Spotify refresh-token rotations that can't be persisted are retried in the
  background until they land (a rotated token existing only in memory must not
  be lost), and `invalid_grant` retries only when the database holds a
  *different* refresh token. Violating any of these bricks the Spotify grant
  and the Car Thing UI then looks "disconnected" even though RFCOMM is fine.
  Wake from sleep must explicitly re-check Spotify auth and reconnect the
  Dealer socket; do not rely on suspended timers alone after a half-day sleep.
  Auth restore already triggers the Spotify auth probe; do not add a second
  unconditional `checkAuthStatus()` during online boot. `SpotifyService`
  single-flights status checks, and Supabase `spotify_credentials` reads should
  select only the credential columns they decrypt/use rather than `select=*`.
  Shared Spotify credential rows used by the iPhone app and macOS connector are
  encrypted as CryptoKit AES-GCM `combined` payloads (nonce + ciphertext + tag)
  with PBKDF2-HMAC-SHA256, 100k iterations, salt
  `com.usenocturne.Nocturne.encryption.v1` + canonical Swift
  `UUID.uuidString` user ID casing. macOS may read legacy lowercase-user-ID
  rows, but new writes must stay iOS-compatible.
- **Spotify Connect identity is stable.** The macOS Dealer registers one
  persisted hidden `hobs_*` device ID and `spotify.player.state` snapshot reads
  reuse the live Dealer `Spotify-Connection-Id` when available. Do not create a
  new hidden Connect-state device for every reconnect or state fetch; stale
  throwaway peers can make the Car Thing UI fall back to "Not Playing" while
  Spotify is still active.
- **Release DMGs use Developer ID notarization.** `just macos-dmg` archives the
  macOS target with hardened runtime, exports with `macos/ExportOptions.plist`,
  builds a DMG, submits it with `xcrun notarytool` using the
  `NOTARY_PROFILE` keychain profile (default `nocturne-notary`), then staples
  and validates the ticket. `just macos-dmg-fast` is a local ad-hoc DMG smoke
  test and is not notarizable; `just macos-dmg-signed-fast` requires a
  Developer ID certificate but skips the notary submit.

## SERVER ↔ CLIENT WIRE CONTRACT

| Surface          | Protocol                | Notes                                                                         |
| ---------------- | ----------------------- | ----------------------------------------------------------------------------- |
| `/api/*`         | HTTP REST (JSON)        | Elysia routes; auth/spotify/info/setup/power                                  |
| `/ws`            | WebSocket               | Single broadcast topic `events`; clients subscribe and receive everything    |
| (server-internal)| RPC over WebSocket      | `nocturne-manager.ts` exposes `onCall(method, handler)` + `onEvent(name, h)` for the BT-tethered Car Thing to call into |

The browser UI talks to the server only via REST + WS; it does NOT implement the RPC layer (that's used between this Pi and the Car Thing).

## CONVENTIONS

- **`src/` IS the deployable.** The image-build process drops `src/` (post-`bun run build`) into the Alpine rootfs at a fixed path, then uses `init` to `bun run start` it on boot.
- **Frontend is built ahead of time.** Vite outputs to `src/dist/client/`, served as static files by Elysia (`@elysiajs/static`). No SSR.
- **Logger is the only sanctioned log call.** `src/server/utils/logger.ts` (level-based: debug/info/warn/error). Avoid bare `console.log` in `src/server/**`.
- **DBus is the BT API**, not bluez-tools/bluetoothctl shell-outs. `dbus-next` in `bluetooth-service.ts`.
- **State persists in Supabase** (`@supabase/supabase-js`), not local SQLite — multi-device users expect their Pi state in the cloud.
- **Local device state persists in `/data`.** Auth/session JSON, setup state, analytics queue data, and `wpa_supplicant.conf` must survive A/B slot changes. Do not write user/device state only into the active rootfs.
- **A/B boot contract:** BOOT is mounted at `/uboot`, root A is partition 2, root B is partition 3, data is partition 4. U-Boot stores slot state in `/uboot/uboot.dat`; `uboot-boot-success` resets the boot counter after local mounts. Do not remove that service or healthy devices can roll back after repeated boots.
- **Connector self-update artifacts:** Releases must publish `nocturne-connector_<version>_update.img.gz` and `.sha256` next to the full `nocturne-connector_<version>.img.gz`. The `_update` file is a gzipped rootfs image for the inactive slot, not a full SD-card image.
- **Connector update notifications:** After a Car Thing RPC handshake succeeds, the connector checks the stable connector release channel and sends `notification.show` with category `connector.ota.available` to that Car Thing when a self-update package is available.
- **Encryption helpers live in one place** (`server/utils/encryption.ts`); don't roll your own.

## ANTI-PATTERNS

- **Don't commit `wpa_supplicant.conf` with real credentials.** The repo file ships with placeholders; users fill it in on the SD card after flash.
- **Don't add bluetooth handling in `routes/`.** Routes are thin HTTP handlers — push device logic into `services/bluetooth-service.ts` so the WS RPC path can reuse it.
- **Don't introduce `node-*` packages** without checking Bun compat. The runtime is Bun, not Node — some `node:*` polyfills work, native bindings often don't.
- **Don't add heavy runtime deps without a reason.** A/B booting duplicates the rootfs and adds `/data`, so compressed image size is no longer the old single-rootfs 60 MB target.
- **Don't run as a non-root user inside the Pi image.** It needs DBus system bus + network config; `LICENSE` tooling assumes root password `nocturne`.
- **Don't hardcode `nocturne-connector.local` in client code.** Use relative URLs — the UI is served same-origin.

## COMMANDS

```bash
# Build the flashable Pi image (top-level)
just run                # → output/nocturne-connector_<version>.img.gz + *_update.img.gz + .sha256 files

# Build only the Bun app (no image packaging)
just connector-api      # bun install + tsc check + vite build, in src/

# Lint
just lint               # pre-commit run --all-files

# macOS connector release DMGs
just macos-dmg          # Developer ID DMG + notarization/stapling
just macos-dmg-fast     # local ad-hoc DMG, not notarized
just macos-dmg-signed-fast # Developer ID DMG, skips notarization

# Cross-arch QEMU helper (registers binfmt for non-arm64 hosts)
just docker-qemu

# Local dev (runs server + Vite together — but won't have BT/DBus on host)
cd src && bun install && bun run dev
```

### Flashing & SSH

- Flash `output/*.img.gz` with Raspberry Pi Imager / balenaEtcher / `dd`.
- Edit `wpa_supplicant.conf` on the SD card root before first boot.
- Visit `http://nocturne-connector.local`. If mDNS doesn't resolve, find the Pi's IP via the router.
- SSH/UART: root password `nocturne`. SSH on port `22` (UART available too — recommended for low-level debug).
- Manual A/B helpers: `ab_active` prints the current root slot; `ab_flash <update.img.gz>` flashes the inactive slot and switches U-Boot for the next reboot.

## NOTES

- **License is Apache** (per `README.md`), distinct from the GPL-licensed firmware repos. Keep new deps' licenses compatible.
- The image generator originates from `gitlab.com/raspi-alpine/builder` — see `resources/` and `build.sh` for the bridging glue.
- Pi 1, Pi 2, Pi Zero 1 are NOT supported (no onboard Wi-Fi or wrong arch). Documented in README.
- `package.json` in `src/` is the source of truth for the runtime stack. The repo root has no `package.json` — keep it that way; the runtime IS the `src/` subtree.
