use crate::bridge::BridgeServer;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use image::{codecs::jpeg::JpegEncoder, imageops::FilterType};
use serde_json::{json, Map, Value};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
};
use tauri::async_runtime;
use tokio::time::sleep;
use windows::core::{implement, Interface};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession, GlobalSystemMediaTransportControlsSessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus,
};
use windows::Media::MediaPlaybackAutoRepeatMode;
use windows::Storage::Streams::DataReader;
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{
    eConsole, eRender, IMMDeviceEnumerator, IMMNotificationClient, IMMNotificationClient_Impl,
    MMDeviceEnumerator,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
};

const POLL_INTERVAL: Duration = Duration::from_millis(250);
const TIMELINE_REANCHOR_INTERVAL: Duration = Duration::from_secs(1);
const TIMELINE_DISCONTINUITY_THRESHOLD_MS: u64 = 1_500;
const PAUSED_TIMELINE_CHANGE_THRESHOLD_MS: u64 = 250;
const ARTWORK_MAX_PIXEL_SIZE: u32 = 300;
const HUNDRED_NS_PER_MILLISECOND: i64 = 10_000;
const WINDOWS_TO_UNIX_EPOCH_SECONDS: i128 = 11_644_473_600;

#[derive(Clone, Copy, Debug, PartialEq)]
struct TimelineSample {
    duration_ms: Option<u64>,
    elapsed_ms: u64,
}

#[derive(Clone, Copy, Debug)]
struct TimelineEmissionAnchor {
    elapsed_ms: u64,
    emitted_at: Instant,
    playback_rate: f64,
    playing: bool,
}

#[implement(IMMNotificationClient)]
struct AudioDeviceNotification {
    bridge: BridgeServer,
    state: WindowsMediaState,
}

impl IMMNotificationClient_Impl for AudioDeviceNotification_Impl {
    fn OnDeviceStateChanged(
        &self,
        _device_id: &windows::core::PCWSTR,
        _new_state: windows::Win32::Media::Audio::DEVICE_STATE,
    ) -> windows::core::Result<()> {
        Ok(())
    }

    fn OnDeviceAdded(&self, _device_id: &windows::core::PCWSTR) -> windows::core::Result<()> {
        Ok(())
    }

    fn OnDeviceRemoved(&self, _device_id: &windows::core::PCWSTR) -> windows::core::Result<()> {
        Ok(())
    }

    fn OnDefaultDeviceChanged(
        &self,
        flow: windows::Win32::Media::Audio::EDataFlow,
        role: windows::Win32::Media::Audio::ERole,
        _device_id: &windows::core::PCWSTR,
    ) -> windows::core::Result<()> {
        if flow != eRender || role != eConsole {
            return Ok(());
        }
        if !self.state.is_enabled() {
            return Ok(());
        }
        if let Ok((volume_percent, muted)) = read_volume_info() {
            self.bridge.emit(
                "device.volume.update",
                json!({ "volume_percent": volume_percent, "muted": muted }),
            );
        }
        Ok(())
    }

    fn OnPropertyValueChanged(
        &self,
        _device_id: &windows::core::PCWSTR,
        _key: &windows::Win32::Foundation::PROPERTYKEY,
    ) -> windows::core::Result<()> {
        Ok(())
    }
}

#[derive(Clone)]
pub struct WindowsMediaState {
    inner: Arc<Mutex<MediaInner>>,
}

struct MediaInner {
    manager: Option<GlobalSystemMediaTransportControlsSessionManager>,
    session: Option<GlobalSystemMediaTransportControlsSession>,
    session_key: Option<String>,
    session_identity: Option<usize>,
    session_epoch: u64,
    generation: u64,
    current_track_key: Option<String>,
    last_update: Option<Value>,
    last_update_signature: Option<String>,
    timeline_anchor: Option<TimelineEmissionAnchor>,
    last_artwork: Option<Value>,
    last_artwork_signature: Option<String>,
    spotify_linked: bool,
    started: bool,
    enabled: bool,
    volume_percent: Option<u8>,
    muted: Option<bool>,
}

impl WindowsMediaState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(MediaInner {
                manager: None,
                session: None,
                session_key: None,
                session_identity: None,
                session_epoch: 0,
                generation: 0,
                current_track_key: None,
                last_update: None,
                last_update_signature: None,
                timeline_anchor: None,
                last_artwork: None,
                last_artwork_signature: None,
                spotify_linked: false,
                started: false,
                enabled: true,
                volume_percent: None,
                muted: None,
            })),
        }
    }

    fn is_enabled(&self) -> bool {
        self.inner
            .lock()
            .map(|inner| inner.enabled)
            .unwrap_or(false)
    }

    pub async fn start(&self, bridge: BridgeServer) {
        let should_start = self
            .inner
            .lock()
            .map(|mut inner| {
                if inner.started {
                    false
                } else {
                    inner.started = true;
                    true
                }
            })
            .unwrap_or(false);
        if !should_start {
            return;
        }

        let state = self.clone();
        start_audio_notifications(bridge.clone(), state.clone());
        async_runtime::spawn(async move {
            if let Err(error) = state.run(bridge).await {
                eprintln!("Windows system media stopped: {error}");
                if let Ok(mut inner) = state.inner.lock() {
                    inner.started = false;
                }
            }
        });
    }

    async fn run(&self, bridge: BridgeServer) -> Result<(), String> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
            .map_err(|error| error.to_string())?
            .get()
            .map_err(|error| error.to_string())?;
        if let Ok(mut inner) = self.inner.lock() {
            inner.manager = Some(manager.clone());
        }

        loop {
            let started = self
                .inner
                .lock()
                .map(|inner| inner.started)
                .unwrap_or(false);
            if !started {
                return Ok(());
            }
            if self.is_enabled() {
                self.refresh(&bridge, &manager).await;
                self.refresh_volume(&bridge);
            }
            sleep(POLL_INTERVAL).await;
        }
    }

    async fn refresh(
        &self,
        bridge: &BridgeServer,
        manager: &GlobalSystemMediaTransportControlsSessionManager,
    ) {
        let session = manager.GetCurrentSession().ok();
        let session_key = session
            .as_ref()
            .and_then(|value| value.SourceAppUserModelId().ok())
            .map(|value| value.to_string());
        let session_identity = session.as_ref().map(|value| value.as_raw() as usize);

        let changed = self
            .inner
            .lock()
            .map(|inner| {
                inner.session_key != session_key || inner.session_identity != session_identity
            })
            .unwrap_or(true);
        if changed {
            if let Ok(mut inner) = self.inner.lock() {
                inner.session = session.clone();
                inner.session_key = session_key;
                inner.session_identity = session_identity;
                inner.session_epoch = inner.session_epoch.saturating_add(1);
                inner.current_track_key = None;
                inner.last_update_signature = None;
                inner.timeline_anchor = None;
                inner.last_artwork = None;
                inner.last_artwork_signature = None;
            }
        }

        let Some(session) = session else {
            self.emit_stopped_if_needed(bridge);
            return;
        };

        let properties = match session.TryGetMediaPropertiesAsync() {
            Ok(operation) => match operation.get() {
                Ok(properties) => properties,
                Err(_) => return,
            },
            Err(_) => return,
        };
        let title = properties.Title().ok().map(|value| value.to_string());
        let artist = properties.Artist().ok().map(|value| value.to_string());
        let album = properties.AlbumTitle().ok().map(|value| value.to_string());
        let source_id = session
            .SourceAppUserModelId()
            .ok()
            .map(|value| value.to_string())
            .unwrap_or_default();
        let app_name = friendly_app_name(&source_id);

        let has_content = title.as_deref().is_some_and(|value| !value.is_empty())
            || artist.as_deref().is_some_and(|value| !value.is_empty());
        if !has_content {
            self.emit_stopped_if_needed(bridge);
            return;
        }
        let spotify = is_spotify_source(&source_id, &app_name);
        let spotify_linked = self
            .inner
            .lock()
            .map(|inner| inner.spotify_linked)
            .unwrap_or(false);
        if spotify && spotify_linked {
            self.emit_stopped_if_needed(bridge);
            return;
        }

        let track_key = format!(
            "{}|{}|{}|{}",
            source_id,
            title.as_deref().unwrap_or_default(),
            artist.as_deref().unwrap_or_default(),
            album.as_deref().unwrap_or_default()
        );
        let playback_info = session.GetPlaybackInfo().ok();
        let status = playback_info
            .as_ref()
            .and_then(|value| value.PlaybackStatus().ok())
            .map(playback_status)
            .unwrap_or("unknown");
        let shuffle = playback_info
            .as_ref()
            .and_then(|value| value.IsShuffleActive().ok())
            .and_then(|value| value.Value().ok())
            .unwrap_or(false);
        let repeat = playback_info
            .as_ref()
            .and_then(|value| value.AutoRepeatMode().ok())
            .and_then(|value| value.Value().ok())
            .map(repeat_mode)
            .unwrap_or("off");
        let playback_rate = normalize_playback_rate(
            playback_info
                .as_ref()
                .and_then(|value| value.PlaybackRate().ok())
                .and_then(|value| value.Value().ok()),
        );
        let timeline = session.GetTimelineProperties().ok().and_then(|value| {
            normalize_timeline(
                value.StartTime().ok().map(|value| value.Duration),
                value.EndTime().ok().map(|value| value.Duration),
                value.Position().ok().map(|value| value.Duration),
                value
                    .LastUpdatedTime()
                    .ok()
                    .map(|value| value.UniversalTime),
                current_windows_time_ticks(),
                status == "playing",
                playback_rate,
            )
        });

        let mut media = Map::new();
        if let Some(title) = title.as_deref().filter(|value| !value.is_empty()) {
            media.insert(
                "MediaItemTitle".to_string(),
                Value::String(title.to_string()),
            );
        }
        if let Some(artist) = artist.as_deref().filter(|value| !value.is_empty()) {
            media.insert(
                "MediaItemArtist".to_string(),
                Value::String(artist.to_string()),
            );
        }
        if let Some(album) = album.as_deref().filter(|value| !value.is_empty()) {
            media.insert(
                "MediaItemAlbumName".to_string(),
                Value::String(album.to_string()),
            );
        }
        if let Some(duration) = timeline.and_then(|value| value.duration_ms) {
            media.insert(
                "MediaItemPlaybackDurationInMilliseconds".to_string(),
                json!(duration),
            );
        }

        let mut playback = json!({
            "PlaybackStatus": status,
            "PlaybackShuffleMode": if shuffle { "songs" } else { "off" },
            "PlaybackRepeatMode": repeat,
            "PlaybackAppName": app_name,
            "PlaybackRate": playback_rate,
        });
        if let (Some(timeline), Some(playback)) = (timeline, playback.as_object_mut()) {
            playback.insert(
                "PlaybackElapsedTimeInMilliseconds".to_string(),
                json!(timeline.elapsed_ms),
            );
        }

        let (generation, session_epoch, update) = self
            .inner
            .lock()
            .map(|mut inner| {
                if inner.current_track_key.as_deref() != Some(track_key.as_str()) {
                    inner.current_track_key = Some(track_key.clone());
                    inner.generation = inner.generation.saturating_add(1);
                    inner.last_artwork = None;
                    inner.last_artwork_signature = None;
                    inner.last_update_signature = None;
                    inner.timeline_anchor = None;
                }
                let update = json!({
                    "media_item_attributes": media,
                    "playback_attributes": playback,
                    "media_generation": inner.generation,
                });
                let signature = now_playing_core_signature(&update);
                let core_changed =
                    inner.last_update_signature.as_deref() != Some(signature.as_str());
                let now = Instant::now();
                let timeline_changed = timeline.is_some_and(|timeline| {
                    timeline_update_due(
                        inner.timeline_anchor.as_ref(),
                        timeline.elapsed_ms,
                        playback_rate,
                        status == "playing",
                        now,
                    )
                });
                let changed = core_changed || timeline_changed;
                if changed {
                    inner.last_update_signature = Some(signature);
                    inner.timeline_anchor = timeline.map(|timeline| TimelineEmissionAnchor {
                        elapsed_ms: timeline.elapsed_ms,
                        emitted_at: now,
                        playback_rate,
                        playing: status == "playing",
                    });
                }
                inner.last_update = Some(update.clone());
                (
                    inner.generation,
                    inner.session_epoch,
                    changed.then_some(update),
                )
            })
            .unwrap_or((0, 0, None));
        if let Some(update) = update {
            bridge.emit("media.now_playing.update", update);
        }

        let artwork = properties.Thumbnail().ok();
        if let Some(artwork) = artwork {
            if let Ok(stream_operation) = artwork.OpenReadAsync() {
                if let Ok(stream) = stream_operation.get() {
                    let reader = match DataReader::CreateDataReader(&stream) {
                        Ok(reader) => reader,
                        Err(_) => return,
                    };
                    let Ok(total_size) = stream.Size() else {
                        return;
                    };
                    let size = total_size.min(4 * 1024 * 1024) as u32;
                    if size == 0 {
                        return;
                    }
                    let Ok(load) = reader.LoadAsync(size) else {
                        return;
                    };
                    if load.get().is_err() {
                        return;
                    }
                    let mut bytes = vec![0; size as usize];
                    if reader.ReadBytes(&mut bytes).is_err() {
                        return;
                    }
                    let Some(encoded) = encode_artwork(&bytes) else {
                        return;
                    };
                    let should_emit = self
                        .inner
                        .lock()
                        .map(|mut inner| {
                            let mut hasher = DefaultHasher::new();
                            encoded.hash(&mut hasher);
                            let signature = format!("{generation}:{:016x}", hasher.finish());
                            if inner.current_track_key.as_deref() != Some(track_key.as_str())
                                || inner.generation != generation
                                || inner.session_epoch != session_epoch
                                || inner.last_artwork_signature.as_deref()
                                    == Some(signature.as_str())
                            {
                                false
                            } else {
                                let data = json!({
                                    "data": encoded,
                                    "content_type": "image/jpeg",
                                    "media_generation": generation,
                                });
                                inner.last_artwork_signature = Some(signature);
                                inner.last_artwork = Some(data.clone());
                                true
                            }
                        })
                        .unwrap_or(false);
                    if should_emit {
                        if let Some(data) = self
                            .inner
                            .lock()
                            .ok()
                            .and_then(|inner| inner.last_artwork.clone())
                        {
                            bridge.emit("media.now_playing.artwork", data);
                        }
                    }
                }
            }
        }
    }

    fn emit_stopped_if_needed(&self, bridge: &BridgeServer) {
        let update = self.inner.lock().ok().and_then(|mut inner| {
            let mut update = inner.last_update.clone()?;
            let playback = update
                .get_mut("playback_attributes")
                .and_then(Value::as_object_mut)?;
            if playback.get("PlaybackStatus") == Some(&Value::String("stopped".to_string())) {
                inner.last_artwork = None;
                inner.last_artwork_signature = None;
                return None;
            }
            playback.insert(
                "PlaybackStatus".to_string(),
                Value::String("stopped".to_string()),
            );
            inner.last_update = Some(update.clone());
            inner.last_update_signature = Some(update.to_string());
            inner.timeline_anchor = None;
            inner.last_artwork = None;
            inner.last_artwork_signature = None;
            Some(update)
        });
        if let Some(update) = update {
            bridge.emit("media.now_playing.update", update);
        }
    }

    pub async fn dispatch(
        &self,
        _bridge: &BridgeServer,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        match method {
            "media.start" => {
                if let Ok(mut inner) = self.inner.lock() {
                    inner.enabled = true;
                    inner.session_epoch = inner.session_epoch.saturating_add(1);
                    inner.current_track_key = None;
                    inner.last_update = None;
                    inner.last_update_signature = None;
                    inner.timeline_anchor = None;
                    inner.last_artwork = None;
                    inner.last_artwork_signature = None;
                }
                Ok(json!({ "status": "ok" }))
            }
            "media.stop" => {
                if let Ok(mut inner) = self.inner.lock() {
                    inner.enabled = false;
                    inner.session_epoch = inner.session_epoch.saturating_add(1);
                    inner.session = None;
                    inner.session_key = None;
                    inner.session_identity = None;
                    inner.current_track_key = None;
                    inner.last_update = None;
                    inner.last_update_signature = None;
                    inner.timeline_anchor = None;
                    inner.last_artwork = None;
                    inner.last_artwork_signature = None;
                    inner.volume_percent = None;
                }
                Ok(json!({ "status": "ok" }))
            }
            "media.set_spotify_linked" => {
                let linked = params
                    .get("linked")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if let Ok(mut inner) = self.inner.lock() {
                    inner.spotify_linked = linked;
                    if linked && inner.last_update.as_ref().is_some_and(is_spotify_update) {
                        inner.current_track_key = None;
                        inner.last_update = None;
                        inner.last_update_signature = None;
                        inner.timeline_anchor = None;
                        inner.last_artwork = None;
                        inner.last_artwork_signature = None;
                    }
                }
                Ok(json!({ "status": "ok" }))
            }
            "volume.get" | "media.get_volume" => {
                match read_volume_info() {
                    Ok((volume, muted)) => {
                        self.update_volume_cache(bridge, volume, muted);
                        Ok(json!({ "status": "ok", "volume_percent": volume, "muted": muted }))
                    }
                    Err(_) => Ok(json!({ "status": "unsupported" })),
                }
            }
            "volume.set" | "media.set_volume" => {
                let requested_num = match parse_number_param(&params, &["volume_percent", "volumePercent", "level"]) {
                    Some(n) => n,
                    None => return Ok(json!({ "status": "unsupported" })),
                };
                let percent = requested_num.round().clamp(0.0, 100.0) as u8;
                let val = set_volume_percent(percent);
                if val.get("status").and_then(Value::as_str) == Some("ok") {
                    if let (Some(v), Some(m)) = (
                        val.get("volume_percent").and_then(Value::as_u64),
                        val.get("muted").and_then(Value::as_bool),
                    ) {
                        self.update_volume_cache(bridge, v as u8, m);
                    }
                }
                Ok(val)
            }
            "volume.adjust" | "media.adjust_volume" => {
                let delta_num = match parse_number_param(&params, &["delta", "amount"]) {
                    Some(n) => n,
                    None => return Ok(json!({ "status": "unsupported" })),
                };
                let delta = delta_num.round().clamp(-100.0, 100.0) as i32;
                let val = adjust_volume_percent(delta);
                if val.get("status").and_then(Value::as_str) == Some("ok") {
                    if let (Some(v), Some(m)) = (
                        val.get("volume_percent").and_then(Value::as_u64),
                        val.get("muted").and_then(Value::as_bool),
                    ) {
                        self.update_volume_cache(bridge, v as u8, m);
                    }
                }
                Ok(val)
            }
            "volume.toggleMute" | "volume.toggle_mute" | "volume.mute" => {
                let explicit = match params.get("muted") {
                    Some(v) => match v.as_bool() {
                        Some(b) => Some(b),
                        None => return Ok(json!({ "status": "unsupported" })),
                    },
                    None => None,
                };
                let val = toggle_mute(explicit);
                if val.get("status").and_then(Value::as_str) == Some("ok") {
                    if let (Some(v), Some(m)) = (
                        val.get("volume_percent").and_then(Value::as_u64),
                        val.get("muted").and_then(Value::as_bool),
                    ) {
                        self.update_volume_cache(bridge, v as u8, m);
                    }
                }
                Ok(val)
            }
            "media.control" => self.control(bridge, params).await,
            _ => Err(format!("Unsupported native media method: {method}")),
        }
    }

    pub fn replay(&self, bridge: &BridgeServer) {
        if let Ok(inner) = self.inner.lock() {
            if !inner.enabled {
                return;
            }
            if let Some(update) = inner.last_update.clone() {
                bridge.emit("media.now_playing.update", update);
            }
            if let Some(artwork) = inner.last_artwork.clone() {
                bridge.emit("media.now_playing.artwork", artwork);
            }
            if let Some(volume) = inner.volume_percent {
                let muted = inner.muted.unwrap_or(false);
                bridge.emit("device.volume.update", json!({ "volume_percent": volume, "muted": muted }));
            }
        }
    }

    fn update_volume_cache(&self, bridge: &BridgeServer, v: u8, m: bool) {
        let changed = if let Ok(mut inner) = self.inner.lock() {
            if inner.volume_percent == Some(v) && inner.muted == Some(m) {
                false
            } else {
                inner.volume_percent = Some(v);
                inner.muted = Some(m);
                true
            }
        } else {
            false
        };
        if changed {
            bridge.emit("device.volume.update", json!({ "volume_percent": v, "muted": m }));
        }
    }

    async fn control(&self, bridge: &BridgeServer, params: Value) -> Result<Value, String> {
        if !self.is_enabled() {
            return Ok(json!({ "status": "disabled" }));
        }
        let action = params
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if action == "volume_up" {
            let val = step_volume(0.0625);
            if val.get("status").and_then(Value::as_str) == Some("ok") {
                if let (Some(v), Some(m)) = (
                    val.get("volume_percent").and_then(Value::as_u64),
                    val.get("muted").and_then(Value::as_bool),
                ) {
                    self.update_volume_cache(bridge, v as u8, m);
                }
            }
            return Ok(val);
        }
        if action == "volume_down" {
            let val = step_volume(-0.0625);
            if val.get("status").and_then(Value::as_str) == Some("ok") {
                if let (Some(v), Some(m)) = (
                    val.get("volume_percent").and_then(Value::as_u64),
                    val.get("muted").and_then(Value::as_bool),
                ) {
                    self.update_volume_cache(bridge, v as u8, m);
                }
            }
            return Ok(val);
        }
        let session = self
            .inner
            .lock()
            .ok()
            .and_then(|inner| inner.session.clone());
        let Some(session) = session else {
            return Ok(json!({ "status": "unsupported" }));
        };
        let result = match action {
            "play" => match session.TryPlayAsync() {
                Ok(operation) => operation.get().ok(),
                Err(_) => None,
            },
            "pause" => match session.TryPauseAsync() {
                Ok(operation) => operation.get().ok(),
                Err(_) => None,
            },
            "stop" => match session.TryStopAsync() {
                Ok(operation) => operation.get().ok(),
                Err(_) => None,
            },
            "toggle" => match session.TryTogglePlayPauseAsync() {
                Ok(operation) => operation.get().ok(),
                Err(_) => None,
            },
            "next" => match session.TrySkipNextAsync() {
                Ok(operation) => operation.get().ok(),
                Err(_) => None,
            },
            "previous" => match session.TrySkipPreviousAsync() {
                Ok(operation) => operation.get().ok(),
                Err(_) => None,
            },
            "shuffle" => {
                let active = session
                    .GetPlaybackInfo()
                    .ok()
                    .and_then(|info| info.IsShuffleActive().ok())
                    .and_then(|value| value.Value().ok())
                    .unwrap_or(false);
                match session.TryChangeShuffleActiveAsync(!active) {
                    Ok(operation) => operation.get().ok(),
                    Err(_) => None,
                }
            }
            "repeat" => {
                let current = session
                    .GetPlaybackInfo()
                    .ok()
                    .and_then(|info| info.AutoRepeatMode().ok())
                    .and_then(|value| value.Value().ok())
                    .unwrap_or(MediaPlaybackAutoRepeatMode::None);
                let next = if current == MediaPlaybackAutoRepeatMode::None {
                    MediaPlaybackAutoRepeatMode::List
                } else if current == MediaPlaybackAutoRepeatMode::List {
                    MediaPlaybackAutoRepeatMode::Track
                } else {
                    MediaPlaybackAutoRepeatMode::None
                };
                match session.TryChangeAutoRepeatModeAsync(next) {
                    Ok(operation) => operation.get().ok(),
                    Err(_) => None,
                }
            }
            "like" | "unlike" => {
                return Ok(json!({ "status": "unsupported" }));
            }
            _ => return Ok(json!({ "status": "unsupported" })),
        };
        Ok(json!({ "status": if result == Some(true) { "ok" } else { "unsupported" } }))
    }

    fn refresh_volume(&self, bridge: &BridgeServer) {
        let Some((percent, muted)) = read_volume_info().ok() else {
            return;
        };
        let changed = self
            .inner
            .lock()
            .map(|mut inner| {
                if inner.volume_percent == Some(percent) && inner.muted == Some(muted) {
                    false
                } else {
                    inner.volume_percent = Some(percent);
                    inner.muted = Some(muted);
                    true
                }
            })
            .unwrap_or(false);
        if changed {
            bridge.emit("device.volume.update", json!({ "volume_percent": percent, "muted": muted }));
        }
    }
}

fn start_audio_notifications(bridge: BridgeServer, state: WindowsMediaState) {
    thread::spawn(move || {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let enumerator: IMMDeviceEnumerator =
            match unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) } {
                Ok(enumerator) => enumerator,
                Err(error) => {
                    eprintln!("Windows audio notifications unavailable: {error}");
                    return;
                }
            };
        let callback: IMMNotificationClient = AudioDeviceNotification {
            bridge,
            state: state.clone(),
        }
        .into();
        if let Err(error) = unsafe { enumerator.RegisterEndpointNotificationCallback(&callback) } {
            eprintln!("Unable to register Windows audio notifications: {error}");
            return;
        }
        loop {
            let started = state
                .inner
                .lock()
                .map(|inner| inner.started)
                .unwrap_or(false);
            if !started {
                break;
            }
            thread::sleep(Duration::from_secs(1));
        }
        let _ = unsafe { enumerator.UnregisterEndpointNotificationCallback(&callback) };
    });
}

fn playback_status(
    status: GlobalSystemMediaTransportControlsSessionPlaybackStatus,
) -> &'static str {
    if status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing {
        "playing"
    } else if status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Paused {
        "paused"
    } else if status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Changing {
        "loading"
    } else if status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Stopped
        || status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Closed
    {
        "stopped"
    } else {
        "unknown"
    }
}

fn repeat_mode(mode: MediaPlaybackAutoRepeatMode) -> &'static str {
    if mode == MediaPlaybackAutoRepeatMode::Track {
        "one"
    } else if mode == MediaPlaybackAutoRepeatMode::List {
        "all"
    } else {
        "off"
    }
}

fn friendly_app_name(source: &str) -> String {
    if is_spotify_source(source, "") {
        return "Spotify".to_string();
    }
    source
        .rsplit_once('!')
        .map(|(_, value)| value)
        .or_else(|| source.rsplit_once('.').map(|(_, value)| value))
        .unwrap_or(source)
        .trim_end_matches(".exe")
        .to_string()
}

fn is_spotify_source(source: &str, name: &str) -> bool {
    source.to_ascii_lowercase().contains("spotify") || name.eq_ignore_ascii_case("spotify")
}

fn is_spotify_update(update: &Value) -> bool {
    update
        .get("playback_attributes")
        .and_then(Value::as_object)
        .and_then(|playback| playback.get("PlaybackAppName"))
        .and_then(Value::as_str)
        .is_some_and(|name| name.eq_ignore_ascii_case("spotify"))
}

fn normalize_playback_rate(rate: Option<f64>) -> f64 {
    rate.filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(1.0)
}

fn normalize_timeline(
    start_ticks: Option<i64>,
    end_ticks: Option<i64>,
    position_ticks: Option<i64>,
    last_updated_ticks: Option<i64>,
    now_ticks: Option<i64>,
    playing: bool,
    playback_rate: f64,
) -> Option<TimelineSample> {
    let start_ticks = i128::from(start_ticks?);
    let position_ticks = i128::from(position_ticks?);
    let duration_ticks = end_ticks
        .map(i128::from)
        .and_then(|end_ticks| (end_ticks > start_ticks).then_some(end_ticks - start_ticks));
    let mut elapsed_ticks = position_ticks.saturating_sub(start_ticks).max(0);

    if playing {
        if let (Some(last_updated_ticks), Some(now_ticks)) = (last_updated_ticks, now_ticks) {
            if last_updated_ticks > 0 && now_ticks >= last_updated_ticks {
                let age_ticks = i128::from(now_ticks - last_updated_ticks);
                let projected = (age_ticks as f64 * normalize_playback_rate(Some(playback_rate)))
                    .round()
                    .clamp(0.0, i64::MAX as f64) as i128;
                elapsed_ticks = elapsed_ticks.saturating_add(projected);
            }
        }
    }

    if let Some(duration_ticks) = duration_ticks {
        elapsed_ticks = elapsed_ticks.min(duration_ticks);
    }
    let elapsed_ms = (elapsed_ticks / i128::from(HUNDRED_NS_PER_MILLISECOND))
        .try_into()
        .unwrap_or(u64::MAX);
    let duration_ms = duration_ticks.and_then(|duration_ticks| {
        let duration_ms = duration_ticks / i128::from(HUNDRED_NS_PER_MILLISECOND);
        (duration_ms > 0).then(|| duration_ms.try_into().unwrap_or(u64::MAX))
    });

    Some(TimelineSample {
        duration_ms,
        elapsed_ms,
    })
}

fn current_windows_time_ticks() -> Option<i64> {
    let elapsed = SystemTime::now().duration_since(UNIX_EPOCH).ok()?;
    let ticks = (i128::from(elapsed.as_secs()) + WINDOWS_TO_UNIX_EPOCH_SECONDS)
        .saturating_mul(10_000_000)
        .saturating_add(i128::from(elapsed.subsec_nanos() / 100));
    ticks.try_into().ok()
}

fn now_playing_core_signature(update: &Value) -> String {
    let mut core = update.clone();
    if let Some(playback) = core
        .get_mut("playback_attributes")
        .and_then(Value::as_object_mut)
    {
        playback.remove("PlaybackElapsedTimeInMilliseconds");
    }
    core.to_string()
}

fn timeline_update_due(
    anchor: Option<&TimelineEmissionAnchor>,
    elapsed_ms: u64,
    playback_rate: f64,
    playing: bool,
    now: Instant,
) -> bool {
    let Some(anchor) = anchor else {
        return true;
    };
    if anchor.playing != playing || (anchor.playback_rate - playback_rate).abs() > 0.001 {
        return true;
    }

    let age = now.saturating_duration_since(anchor.emitted_at);
    let expected_elapsed_ms = if anchor.playing {
        anchor.elapsed_ms.saturating_add(
            (age.as_secs_f64() * 1_000.0 * anchor.playback_rate)
                .round()
                .clamp(0.0, u64::MAX as f64) as u64,
        )
    } else {
        anchor.elapsed_ms
    };
    let difference = elapsed_ms.abs_diff(expected_elapsed_ms);
    if difference >= TIMELINE_DISCONTINUITY_THRESHOLD_MS {
        return true;
    }
    if !playing && difference >= PAUSED_TIMELINE_CHANGE_THRESHOLD_MS {
        return true;
    }
    playing && age >= TIMELINE_REANCHOR_INTERVAL
}

fn encode_artwork(bytes: &[u8]) -> Option<String> {
    let image = image::load_from_memory(bytes).ok()?;
    let image =
        if image.width() <= ARTWORK_MAX_PIXEL_SIZE && image.height() <= ARTWORK_MAX_PIXEL_SIZE {
            image
        } else {
            image.resize(
                ARTWORK_MAX_PIXEL_SIZE,
                ARTWORK_MAX_PIXEL_SIZE,
                FilterType::Lanczos3,
            )
        };
    let mut output = Vec::new();
    let mut encoder = JpegEncoder::new_with_quality(&mut output, 80);
    encoder.encode_image(&image).ok()?;
    Some(BASE64.encode(output))
}

fn parse_number_param(params: &Value, keys: &[&str]) -> Option<f64> {
    for key in keys {
        if let Some(v) = params.get(key) {
            if let Some(n) = v.as_f64() {
                if n.is_finite() {
                    return Some(n);
                }
            }
            return None;
        }
    }
    None
}

fn endpoint_volume() -> Result<IAudioEndpointVolume, String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|error| error.to_string())?;
        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eConsole)
            .map_err(|error| error.to_string())?;
        device
            .Activate(CLSCTX_ALL, None)
            .map_err(|error| error.to_string())
    }
}

fn read_volume_info() -> Result<(u8, bool), String> {
    let endpoint = endpoint_volume()?;
    let scalar =
        unsafe { endpoint.GetMasterVolumeLevelScalar() }.map_err(|error| error.to_string())?;
    let muted = unsafe { endpoint.GetMute() }
        .map(|m| m.as_bool())
        .unwrap_or(false);
    Ok(((scalar.clamp(0.0, 1.0) * 100.0).round() as u8, muted))
}

fn set_volume_percent(percent: u8) -> Value {
    let result = (|| -> Result<(u8, bool), String> {
        let endpoint = endpoint_volume()?;
        let scalar = (percent as f32 / 100.0).clamp(0.0, 1.0);
        unsafe { endpoint.SetMasterVolumeLevelScalar(scalar, std::ptr::null()) }
            .map_err(|error| error.to_string())?;
        let muted = unsafe { endpoint.GetMute() }
            .map(|m| m.as_bool())
            .unwrap_or(false);
        Ok((percent, muted))
    })();
    match result {
        Ok((v, m)) => json!({ "status": "ok", "volume_percent": v, "muted": m }),
        Err(_) => json!({ "status": "unsupported" }),
    }
}

fn adjust_volume_percent(delta: i32) -> Value {
    let result = (|| -> Result<(u8, bool), String> {
        let endpoint = endpoint_volume()?;
        let current =
            unsafe { endpoint.GetMasterVolumeLevelScalar() }.map_err(|error| error.to_string())?;
        let current_pct = (current.clamp(0.0, 1.0) * 100.0).round() as i32;
        let next_pct = (current_pct + delta).clamp(0, 100) as u8;
        let scalar = (next_pct as f32 / 100.0).clamp(0.0, 1.0);
        unsafe { endpoint.SetMasterVolumeLevelScalar(scalar, std::ptr::null()) }
            .map_err(|error| error.to_string())?;
        let muted = unsafe { endpoint.GetMute() }
            .map(|m| m.as_bool())
            .unwrap_or(false);
        Ok((next_pct, muted))
    })();
    match result {
        Ok((v, m)) => json!({ "status": "ok", "volume_percent": v, "muted": m }),
        Err(_) => json!({ "status": "unsupported" }),
    }
}

fn toggle_mute(explicit: Option<bool>) -> Value {
    let result = (|| -> Result<(u8, bool), String> {
        let endpoint = endpoint_volume()?;
        let current_mute = unsafe { endpoint.GetMute() }
            .map(|m| m.as_bool())
            .unwrap_or(false);
        let target_mute = explicit.unwrap_or(!current_mute);
        unsafe { endpoint.SetMute(target_mute, std::ptr::null()) }
            .map_err(|error| error.to_string())?;
        let scalar =
            unsafe { endpoint.GetMasterVolumeLevelScalar() }.map_err(|error| error.to_string())?;
        let pct = (scalar.clamp(0.0, 1.0) * 100.0).round() as u8;
        Ok((pct, target_mute))
    })();
    match result {
        Ok((v, m)) => json!({ "status": "ok", "volume_percent": v, "muted": m }),
        Err(_) => json!({ "status": "unsupported" }),
    }
}

fn step_volume(delta: f32) -> Value {
    let result = (|| -> Result<(u8, bool), String> {
        let endpoint = endpoint_volume()?;
        let current =
            unsafe { endpoint.GetMasterVolumeLevelScalar() }.map_err(|error| error.to_string())?;
        let next = (current + delta).clamp(0.0, 1.0);
        unsafe { endpoint.SetMasterVolumeLevelScalar(next, std::ptr::null()) }
            .map_err(|error| error.to_string())?;
        let pct = (next * 100.0).round() as u8;
        let muted = unsafe { endpoint.GetMute() }
            .map(|m| m.as_bool())
            .unwrap_or(false);
        Ok((pct, muted))
    })();
    match result {
        Ok((v, m)) => json!({ "status": "ok", "volume_percent": v, "muted": m }),
        Err(_) => json!({ "status": "unsupported" }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const fn milliseconds(value: i64) -> i64 {
        value * HUNDRED_NS_PER_MILLISECOND
    }

    #[test]
    fn timeline_is_relative_to_start_and_projects_playing_position() {
        let timeline = normalize_timeline(
            Some(milliseconds(5_000)),
            Some(milliseconds(105_000)),
            Some(milliseconds(15_000)),
            Some(milliseconds(200_000)),
            Some(milliseconds(202_000)),
            true,
            1.25,
        );
        assert_eq!(
            timeline,
            Some(TimelineSample {
                duration_ms: Some(100_000),
                elapsed_ms: 12_500,
            })
        );
    }

    #[test]
    fn paused_timeline_preserves_zero_and_never_projects() {
        let zero = normalize_timeline(
            Some(milliseconds(5_000)),
            Some(milliseconds(105_000)),
            Some(milliseconds(5_000)),
            Some(milliseconds(200_000)),
            Some(milliseconds(250_000)),
            false,
            1.0,
        );
        assert_eq!(
            zero,
            Some(TimelineSample {
                duration_ms: Some(100_000),
                elapsed_ms: 0,
            })
        );
    }

    #[test]
    fn timeline_clamps_invalid_bounds_without_overflowing() {
        let before_start = normalize_timeline(
            Some(milliseconds(10_000)),
            None,
            Some(milliseconds(5_000)),
            None,
            None,
            true,
            1.0,
        );
        assert_eq!(
            before_start,
            Some(TimelineSample {
                duration_ms: None,
                elapsed_ms: 0,
            })
        );

        let after_end = normalize_timeline(
            Some(milliseconds(10_000)),
            Some(milliseconds(20_000)),
            Some(i64::MAX),
            Some(1),
            Some(i64::MAX),
            true,
            f64::INFINITY,
        );
        assert_eq!(
            after_end,
            Some(TimelineSample {
                duration_ms: Some(10_000),
                elapsed_ms: 10_000,
            })
        );
        assert_eq!(
            normalize_timeline(None, None, None, None, None, true, 1.0),
            None
        );
    }

    #[test]
    fn playback_rate_accepts_only_positive_finite_multipliers() {
        assert_eq!(normalize_playback_rate(Some(1.25)), 1.25);
        for rate in [
            None,
            Some(0.0),
            Some(-1.0),
            Some(f64::NAN),
            Some(f64::INFINITY),
        ] {
            assert_eq!(normalize_playback_rate(rate), 1.0);
        }
    }

    #[test]
    fn timeline_updates_are_throttled_but_seeks_and_paused_changes_are_immediate() {
        let start = Instant::now();
        let playing = TimelineEmissionAnchor {
            elapsed_ms: 10_000,
            emitted_at: start,
            playback_rate: 1.0,
            playing: true,
        };
        assert!(!timeline_update_due(
            Some(&playing),
            10_250,
            1.0,
            true,
            start + Duration::from_millis(250),
        ));
        assert!(timeline_update_due(
            Some(&playing),
            11_000,
            1.0,
            true,
            start + TIMELINE_REANCHOR_INTERVAL,
        ));
        assert!(timeline_update_due(
            Some(&playing),
            20_000,
            1.0,
            true,
            start + Duration::from_millis(250),
        ));

        let paused = TimelineEmissionAnchor {
            elapsed_ms: 10_000,
            emitted_at: start,
            playback_rate: 1.0,
            playing: false,
        };
        assert!(!timeline_update_due(
            Some(&paused),
            10_100,
            1.0,
            false,
            start + Duration::from_secs(5),
        ));
        assert!(timeline_update_due(
            Some(&paused),
            10_500,
            1.0,
            false,
            start + Duration::from_millis(250),
        ));
    }

    #[test]
    fn now_playing_signature_ignores_only_elapsed_anchor() {
        let first = json!({
            "media_item_attributes": { "MediaItemTitle": "Song" },
            "playback_attributes": {
                "PlaybackStatus": "playing",
                "PlaybackElapsedTimeInMilliseconds": 1_000,
                "PlaybackRate": 1.0,
            },
            "media_generation": 4,
        });
        let mut second = first.clone();
        second["playback_attributes"]["PlaybackElapsedTimeInMilliseconds"] = json!(2_000);
        assert_eq!(
            now_playing_core_signature(&first),
            now_playing_core_signature(&second)
        );
        second["playback_attributes"]["PlaybackRate"] = json!(1.25);
        assert_ne!(
            now_playing_core_signature(&first),
            now_playing_core_signature(&second)
        );
    }
}
