use crate::bridge::BridgeServer;
use base64::Engine as _;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use uuid::Uuid;
use windows::core::{GUID, HSTRING};
use windows::Devices::Bluetooth::{BluetoothConnectionStatus, BluetoothDevice, BluetoothLEDevice};
use windows::Devices::Enumeration::{
    DeviceInformation, DeviceInformationCustomPairing, DeviceInformationUpdate, DevicePairingKinds,
    DevicePairingRequestedEventArgs, DevicePairingResultStatus, DeviceWatcher,
};
use windows::Foundation::TypedEventHandler;
use windows::Win32::Devices::Bluetooth::{
    BluetoothAuthenticateDeviceEx, BluetoothEnableDiscovery, BluetoothEnableIncomingConnections,
    BluetoothFindDeviceClose, BluetoothFindFirstDevice, BluetoothFindFirstRadio,
    BluetoothFindNextDevice, BluetoothFindRadioClose, BluetoothGetDeviceInfo,
    BluetoothGetRadioInfo, BluetoothIsConnectable, BluetoothIsDiscoverable, BluetoothRemoveDevice,
    AF_BTH, AUTHENTICATION_REQUIREMENTS, BLUETOOTH_ADDRESS, BLUETOOTH_DEVICE_INFO,
    BLUETOOTH_DEVICE_SEARCH_PARAMS, BLUETOOTH_FIND_RADIO_PARAMS, BLUETOOTH_RADIO_INFO,
    BTHPROTO_RFCOMM, NS_BTH, SOCKADDR_BTH, SOL_RFCOMM, SO_BTH_AUTHENTICATE, SO_BTH_ENCRYPT,
};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Networking::WinSock::{
    accept, bind, closesocket, connect, getsockname, listen, recv, send, setsockopt, socket,
    WSAGetLastError, WSASetServiceW, WSAStartup, CSADDR_INFO, RNRSERVICE_REGISTER, SEND_RECV_FLAGS,
    SOCKADDR, SOCKET, SOCKET_ADDRESS, SOCK_STREAM, SOL_SOCKET, SO_SNDTIMEO, WSADATA, WSAQUERYSETW,
};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

const RFCOMM_SERVER_CHANNEL: u32 = 1;
const PROBE_CHANNEL: u32 = 3;
const PROBE_HOLD: Duration = Duration::from_millis(500);
const DISCOVERY_REFRESH: Duration = Duration::from_secs(3);

#[derive(Clone)]
pub struct WindowsBluetoothState {
    inner: Arc<Mutex<Inner>>,
}

struct Inner {
    bridge: Option<BridgeServer>,
    radio: Option<usize>,
    radio_address: String,
    discovering: bool,
    servers_started: bool,
    devices: HashMap<String, Value>,
    server_connections: HashMap<String, SOCKET>,
    client_socket: Option<SOCKET>,
    client_address: String,
    route_generation: u64,
    monitor_started: bool,
    winrt_watchers: Vec<DeviceWatcher>,
    winrt_ids: HashMap<String, HashSet<String>>,
    pairing_address: Option<String>,
    pending_pairing: Option<PendingPairing>,
}

struct PendingPairing {
    address: String,
    decision: SyncSender<bool>,
}

impl WindowsBluetoothState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                bridge: None,
                radio: None,
                radio_address: String::new(),
                discovering: false,
                servers_started: false,
                devices: HashMap::new(),
                server_connections: HashMap::new(),
                client_socket: None,
                client_address: String::new(),
                route_generation: 0,
                monitor_started: false,
                winrt_watchers: Vec::new(),
                winrt_ids: HashMap::new(),
                pairing_address: None,
                pending_pairing: None,
            })),
        }
    }

    pub async fn start(&self, bridge: BridgeServer) {
        let should_start_monitor = self
            .inner
            .lock()
            .map(|mut inner| {
                inner.bridge = Some(bridge);
                if inner.monitor_started {
                    false
                } else {
                    inner.monitor_started = true;
                    true
                }
            })
            .unwrap_or(false);
        if should_start_monitor {
            let state = self.clone();
            thread::spawn(move || monitor_loop(state));
        }
    }

    pub fn reset_routes(&self) {
        let (client, client_address, servers, bridge, pending_pairing) = match self.inner.lock() {
            Ok(mut inner) => {
                inner.route_generation = if inner.route_generation == u64::MAX {
                    0
                } else {
                    inner.route_generation + 1
                };
                let client_address = inner.client_address.clone();
                let bridge = inner.bridge.clone();
                inner.client_address.clear();
                let client = inner.client_socket.take();
                let servers = inner.server_connections.drain().collect::<Vec<_>>();
                let pending_pairing = inner.pending_pairing.take();
                (client, client_address, servers, bridge, pending_pairing)
            }
            Err(_) => return,
        };
        if let Some(bridge) = bridge {
            if !client_address.is_empty() {
                bridge.emit(
                    "rfcomm.client.disconnected",
                    json!({ "address": client_address }),
                );
            }
            for (connection_id, _) in &servers {
                bridge.emit(
                    "rfcomm.server.disconnected",
                    json!({ "connectionId": connection_id }),
                );
            }
        }
        if let Some(socket) = client {
            thread::spawn(move || close_socket(socket));
        }
        for (_, socket) in servers {
            thread::spawn(move || close_socket(socket));
        }
        if let Some(pending) = pending_pairing {
            let _ = pending.decision.send(false);
        }
    }

    fn route_generation(&self) -> u64 {
        self.inner
            .lock()
            .map(|inner| inner.route_generation)
            .unwrap_or(u64::MAX)
    }

    fn is_route_generation(&self, generation: u64) -> bool {
        self.route_generation() == generation
    }

    pub async fn dispatch(
        &self,
        bridge: &BridgeServer,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        if let Ok(mut inner) = self.inner.lock() {
            inner.bridge = Some(bridge.clone());
        }
        match method {
            "bluetooth.initialize" => {
                self.ensure_radio()?;
                Ok(json!({ "status": "ok" }))
            }
            "bluetooth.get_status" => Ok(self.status()),
            "bluetooth.get_devices" => Ok(json!(self.get_devices()?)),
            "bluetooth.set_power" => Ok(json!({ "status": "ok" })),
            "bluetooth.set_discoverable" => {
                self.set_discoverable(
                    params
                        .get("enabled")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                )?;
                Ok(json!({ "status": "ok" }))
            }
            "bluetooth.set_pairable" => {
                self.set_pairable(
                    params
                        .get("enabled")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                )?;
                Ok(json!({ "status": "ok" }))
            }
            "bluetooth.start_discovery" => {
                self.start_discovery();
                Ok(json!({ "status": "ok" }))
            }
            "bluetooth.stop_discovery" => {
                if let Ok(mut inner) = self.inner.lock() {
                    inner.discovering = false;
                }
                self.stop_winrt_discovery();
                Ok(json!({ "status": "ok" }))
            }
            "bluetooth.pair" => {
                let address = required_string(&params, "address")?;
                self.pair(address, bridge.clone()).await?;
                Ok(json!({ "status": "ok" }))
            }
            "bluetooth.trust" => Ok(json!({ "status": "ok" })),
            "bluetooth.remove" => {
                let address = required_string(&params, "address")?;
                let _ = self.try_remove_winrt(&address)?;
                self.remove(&address)?;
                if let Ok(mut inner) = self.inner.lock() {
                    inner.devices.remove(&address);
                    inner.winrt_ids.remove(&address);
                }
                Ok(json!({ "status": "ok" }))
            }
            "rfcomm.server.register" => {
                self.start_servers(bridge.clone())?;
                Ok(json!({ "status": "ok" }))
            }
            "rfcomm.server.write" => {
                let connection_id = required_string(&params, "connectionId")?;
                let data = bytes_param(&params, "data")?;
                self.write_server(&connection_id, data).await?;
                Ok(json!({ "status": "ok" }))
            }
            "rfcomm.server.disconnect" => {
                let connection_id = required_string(&params, "connectionId")?;
                self.disconnect_server(&connection_id)?;
                Ok(json!({ "status": "ok" }))
            }
            "rfcomm.client.connect" => {
                let address = required_string(&params, "address")?;
                let channel = params.get("channel").and_then(Value::as_u64).unwrap_or(2) as u32;
                self.connect_client(&address, channel)?;
                Ok(json!({ "status": "ok" }))
            }
            "rfcomm.client.write" => {
                let data = bytes_param(&params, "data")?;
                self.write_client(data).await?;
                Ok(json!({ "status": "ok" }))
            }
            "rfcomm.client.disconnect" => {
                self.disconnect_client();
                Ok(json!({ "status": "ok" }))
            }
            "bluetooth.pairing.confirm" => {
                self.resolve_pairing(true)?;
                Ok(json!({ "status": "ok" }))
            }
            "bluetooth.pairing.reject" => {
                self.resolve_pairing(false)?;
                Ok(json!({ "status": "ok" }))
            }
            _ => Err(format!("Unsupported native Bluetooth method: {method}")),
        }
    }

    fn ensure_radio(&self) -> Result<(), String> {
        let existing_radio = self.inner.lock().ok().and_then(|inner| inner.radio);
        if let Some(existing_radio) = existing_radio {
            let mut info = BLUETOOTH_RADIO_INFO {
                dwSize: std::mem::size_of::<BLUETOOTH_RADIO_INFO>() as u32,
                ..Default::default()
            };
            let result = unsafe {
                BluetoothGetRadioInfo(HANDLE(existing_radio as *mut std::ffi::c_void), &mut info)
            };
            if result == 0 {
                return Ok(());
            }
            unsafe {
                let _ = CloseHandle(HANDLE(existing_radio as *mut std::ffi::c_void));
            }
            if let Ok(mut inner) = self.inner.lock() {
                inner.radio = None;
                inner.radio_address.clear();
            }
        }
        startup_winsock()?;
        let params = BLUETOOTH_FIND_RADIO_PARAMS {
            dwSize: std::mem::size_of::<BLUETOOTH_FIND_RADIO_PARAMS>() as u32,
        };
        let mut radio = HANDLE::default();
        let finder = unsafe { BluetoothFindFirstRadio(&params, &mut radio) }
            .map_err(|error| format!("No Windows Bluetooth radio is available: {error}"))?;
        let mut info = BLUETOOTH_RADIO_INFO {
            dwSize: std::mem::size_of::<BLUETOOTH_RADIO_INFO>() as u32,
            ..Default::default()
        };
        let result = unsafe { BluetoothGetRadioInfo(radio, &mut info) };
        unsafe {
            let _ = BluetoothFindRadioClose(finder);
        }
        if result != 0 {
            unsafe {
                CloseHandle(radio).ok();
            }
            return Err(format!(
                "Unable to read Bluetooth radio information: {result}"
            ));
        }
        let address = unsafe { info.address.Anonymous.ullLong };
        if let Ok(mut inner) = self.inner.lock() {
            inner.radio = Some(radio.0 as usize);
            inner.radio_address = format_address(address);
        }
        Ok(())
    }

    fn status(&self) -> Value {
        let inner = match self.inner.lock() {
            Ok(inner) => inner,
            Err(_) => return json!({ "powered": false, "discovering": false, "address": "" }),
        };
        json!({
            "powered": inner.radio.is_some(),
            "discovering": inner.discovering,
            "address": inner.radio_address,
        })
    }

    fn enumerate_devices(&self) -> Result<Vec<Value>, String> {
        self.ensure_radio()?;
        let inner = self
            .inner
            .lock()
            .map_err(|_| "Bluetooth state is poisoned".to_string())?;
        drop(inner);
        let search = BLUETOOTH_DEVICE_SEARCH_PARAMS {
            dwSize: std::mem::size_of::<BLUETOOTH_DEVICE_SEARCH_PARAMS>() as u32,
            fReturnAuthenticated: true.into(),
            fReturnRemembered: true.into(),
            fReturnUnknown: true.into(),
            fReturnConnected: true.into(),
            // Active inquiries are owned by the WinRT DeviceWatcher below;
            // keeping this legacy snapshot passive avoids two concurrent
            // inquiries competing for the same adapter.
            fIssueInquiry: false.into(),
            cTimeoutMultiplier: 2,
            hRadio: HANDLE::default(),
        };
        let mut info = BLUETOOTH_DEVICE_INFO {
            dwSize: std::mem::size_of::<BLUETOOTH_DEVICE_INFO>() as u32,
            ..Default::default()
        };
        let mut discovered = Vec::new();
        if let Ok(finder) = unsafe { BluetoothFindFirstDevice(&search, &mut info) } {
            loop {
                discovered.push(device_json(&info));
                if unsafe { BluetoothFindNextDevice(finder, &mut info) }.is_err() {
                    break;
                }
            }
            unsafe {
                BluetoothFindDeviceClose(finder).ok();
            }
        }
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Bluetooth state is poisoned".to_string())?;
        for device in discovered {
            if let Some(address) = device
                .get("address")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
            {
                let merged = merge_device(inner.devices.get(&address), device);
                inner.devices.insert(address, merged);
            }
        }
        Ok(inner.devices.values().cloned().collect())
    }

    fn get_devices(&self) -> Result<Vec<Value>, String> {
        let discovering = self
            .inner
            .lock()
            .map(|inner| inner.discovering)
            .map_err(|_| "Bluetooth state is poisoned".to_string())?;
        if discovering {
            return self
                .inner
                .lock()
                .map(|inner| inner.devices.values().cloned().collect())
                .map_err(|_| "Bluetooth state is poisoned".to_string());
        }
        self.enumerate_devices()
    }

    fn start_winrt_discovery(&self) {
        let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        let selectors = [
            (
                BluetoothDevice::GetDeviceSelectorFromPairingState(false),
                false,
            ),
            (
                BluetoothLEDevice::GetDeviceSelectorFromPairingState(false),
                true,
            ),
        ];
        let mut watchers = Vec::new();
        for (selector, low_energy) in selectors {
            let selector = match selector {
                Ok(selector) => selector,
                Err(error) => {
                    eprintln!("Windows Bluetooth selector failed: {error}");
                    continue;
                }
            };
            let watcher = match DeviceInformation::CreateWatcherAqsFilter(&selector) {
                Ok(watcher) => watcher,
                Err(error) => {
                    eprintln!("Windows Bluetooth watcher could not start: {error}");
                    continue;
                }
            };
            let state = self.clone();
            let added = TypedEventHandler::<DeviceWatcher, DeviceInformation>::new(
                move |_sender, information| {
                    if let Some(information) = information.as_ref() {
                        state.ingest_winrt_device(information, low_energy);
                    }
                    Ok(())
                },
            );
            if let Err(error) = watcher.Added(&added) {
                eprintln!("Windows Bluetooth watcher add handler failed: {error}");
                continue;
            }
            let state = self.clone();
            let updated = TypedEventHandler::<DeviceWatcher, DeviceInformationUpdate>::new(
                move |_sender, update| {
                    if let Some(update) = update.as_ref() {
                        state.ingest_winrt_update(update, low_energy);
                    }
                    Ok(())
                },
            );
            if let Err(error) = watcher.Updated(&updated) {
                eprintln!("Windows Bluetooth watcher update handler failed: {error}");
                continue;
            }
            let state = self.clone();
            let removed = TypedEventHandler::<DeviceWatcher, DeviceInformationUpdate>::new(
                move |_sender, update| {
                    if let Some(update) = update.as_ref() {
                        state.remove_winrt_device(update);
                    }
                    Ok(())
                },
            );
            if let Err(error) = watcher.Removed(&removed) {
                eprintln!("Windows Bluetooth watcher remove handler failed: {error}");
                continue;
            }
            if let Err(error) = watcher.Start() {
                eprintln!("Windows Bluetooth watcher failed to start: {error}");
                continue;
            }
            eprintln!(
                "Windows Bluetooth watcher started (low_energy={low_energy}, status={})",
                watcher.Status().map(|status| status.0).unwrap_or(-1)
            );
            watchers.push(watcher);
        }
        let mut pending_watchers = Some(watchers);
        let should_stop = self
            .inner
            .lock()
            .map(|mut inner| {
                if inner.discovering {
                    inner
                        .winrt_watchers
                        .extend(pending_watchers.take().unwrap_or_default());
                    false
                } else {
                    true
                }
            })
            .unwrap_or(true);
        if should_stop {
            for watcher in pending_watchers.unwrap_or_default() {
                let _ = watcher.Stop();
            }
        }
    }

    fn stop_winrt_discovery(&self) {
        let watchers = self
            .inner
            .lock()
            .map(|mut inner| std::mem::take(&mut inner.winrt_watchers))
            .unwrap_or_default();
        for watcher in watchers {
            let _ = watcher.Stop();
        }
    }

    fn ingest_winrt_device(&self, information: &DeviceInformation, low_energy: bool) {
        let Some((address, device)) = resolve_winrt_device(information, low_energy) else {
            return;
        };
        let id = information.Id().ok().map(|id| id.to_string());
        let (bridge, topic, device) = match self.inner.lock() {
            Ok(mut inner) => {
                let existed = inner.devices.contains_key(&address);
                let device = merge_device(inner.devices.get(&address), device);
                let changed = inner.devices.get(&address) != Some(&device);
                inner.devices.insert(address.clone(), device.clone());
                if let Some(id) = id {
                    inner
                        .winrt_ids
                        .entry(address.clone())
                        .or_default()
                        .insert(id);
                }
                let topic = changed.then_some(if existed {
                    "bluetooth.device_updated"
                } else {
                    "bluetooth.device_found"
                });
                (inner.bridge.clone(), topic, device)
            }
            Err(_) => (None, None, device),
        };
        if let Some(topic) = topic {
            if let Some(bridge) = bridge {
                bridge.emit(topic, device);
            }
        }
    }

    fn ingest_winrt_update(&self, update: &DeviceInformationUpdate, low_energy: bool) {
        let Ok(id) = update.Id() else { return };
        let Ok(information) =
            DeviceInformation::CreateFromIdAsync(&id).and_then(|operation| operation.get())
        else {
            return;
        };
        self.ingest_winrt_device(&information, low_energy);
    }

    fn remove_winrt_device(&self, update: &DeviceInformationUpdate) {
        let Ok(id) = update.Id() else { return };
        let id = id.to_string();
        let (bridge, removed) = match self.inner.lock() {
            Ok(mut inner) => {
                let address = inner
                    .winrt_ids
                    .iter()
                    .find_map(|(address, ids)| ids.contains(&id).then_some(address.clone()));
                let Some(address) = address else { return };
                let ids_empty = if let Some(ids) = inner.winrt_ids.get_mut(&address) {
                    ids.remove(&id);
                    ids.is_empty()
                } else {
                    false
                };
                if ids_empty {
                    inner.winrt_ids.remove(&address);
                }
                let keep = inner.winrt_ids.contains_key(&address)
                    || inner
                        .devices
                        .get(&address)
                        .and_then(|device| device.get("paired"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                let removed = if keep {
                    false
                } else {
                    inner.devices.remove(&address).is_some()
                };
                (inner.bridge.clone(), removed)
            }
            Err(_) => (None, false),
        };
        if removed {
            if let Some(bridge) = bridge {
                bridge.emit("bluetooth.adapter_status", self.status());
            }
        }
    }

    fn set_discoverable(&self, enabled: bool) -> Result<(), String> {
        self.ensure_radio()?;
        let radio = self
            .inner
            .lock()
            .map_err(|_| "Bluetooth state is poisoned".to_string())?
            .radio;
        let Some(radio) = radio else {
            return Err("Bluetooth radio is unavailable".to_string());
        };
        let radio = HANDLE(radio as *mut std::ffi::c_void);
        if unsafe { BluetoothIsDiscoverable(Some(radio)) }.as_bool() == enabled {
            return Ok(());
        }
        if enabled
            && !unsafe { BluetoothIsConnectable(Some(radio)) }.as_bool()
            && unsafe { BluetoothEnableIncomingConnections(Some(radio), true) }.0 == 0
            && !unsafe { BluetoothIsConnectable(Some(radio)) }.as_bool()
        {
            return Err(
                "Windows refused incoming Bluetooth connections required for discoverability"
                    .to_string(),
            );
        }
        if unsafe { BluetoothEnableDiscovery(Some(radio), enabled) }.0 == 0
            && unsafe { BluetoothIsDiscoverable(Some(radio)) }.as_bool() != enabled
        {
            return Err("Windows refused the Bluetooth discoverability change".to_string());
        }
        Ok(())
    }

    fn set_pairable(&self, enabled: bool) -> Result<(), String> {
        self.ensure_radio()?;
        let radio = self
            .inner
            .lock()
            .map_err(|_| "Bluetooth state is poisoned".to_string())?
            .radio;
        let Some(radio) = radio else {
            return Err("Bluetooth radio is unavailable".to_string());
        };
        let radio = HANDLE(radio as *mut std::ffi::c_void);
        if unsafe { BluetoothIsConnectable(Some(radio)) }.as_bool() == enabled {
            return Ok(());
        }
        if !enabled
            && unsafe { BluetoothIsDiscoverable(Some(radio)) }.as_bool()
            && unsafe { BluetoothEnableDiscovery(Some(radio), false) }.0 == 0
            && unsafe { BluetoothIsDiscoverable(Some(radio)) }.as_bool()
        {
            return Err("Windows refused to disable Bluetooth discoverability".to_string());
        }
        if unsafe { BluetoothEnableIncomingConnections(Some(radio), enabled) }.0 == 0
            && unsafe { BluetoothIsConnectable(Some(radio)) }.as_bool() != enabled
        {
            return Err("Windows refused incoming Bluetooth connections".to_string());
        }
        Ok(())
    }

    fn start_discovery(&self) {
        let should_start = self
            .inner
            .lock()
            .map(|mut inner| {
                if inner.discovering {
                    false
                } else {
                    inner.devices.retain(|_, device| {
                        device
                            .get("paired")
                            .and_then(Value::as_bool)
                            .unwrap_or(false)
                    });
                    let remembered = inner.devices.keys().cloned().collect::<HashSet<_>>();
                    inner
                        .winrt_ids
                        .retain(|address, _| remembered.contains(address));
                    inner.discovering = true;
                    true
                }
            })
            .unwrap_or(false);
        if !should_start {
            return;
        }
        let state = self.clone();
        thread::spawn(move || {
            state.start_winrt_discovery();
            loop {
                let discovering = state
                    .inner
                    .lock()
                    .map(|inner| inner.discovering)
                    .unwrap_or(false);
                if !discovering {
                    break;
                }
                let previous = state
                    .inner
                    .lock()
                    .map(|inner| inner.devices.clone())
                    .unwrap_or_default();
                if let Err(error) = state.enumerate_devices() {
                    eprintln!("Windows Bluetooth enumeration failed: {error}");
                }
                let (bridge, current) = match state.inner.lock() {
                    Ok(inner) => (inner.bridge.clone(), inner.devices.clone()),
                    Err(_) => (None, HashMap::new()),
                };
                if let Some(bridge) = bridge {
                    for (address, device) in current {
                        match previous.get(&address) {
                            None => bridge.emit("bluetooth.device_found", device),
                            Some(previous) if previous != &device => {
                                bridge.emit("bluetooth.device_updated", device);
                            }
                            Some(_) => {}
                        }
                    }
                }
                thread::sleep(DISCOVERY_REFRESH);
            }
            state.stop_winrt_discovery();
        });
    }

    async fn pair(&self, address: String, bridge: BridgeServer) -> Result<(), String> {
        {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "Bluetooth state is poisoned".to_string())?;
            if let Some(active) = &inner.pairing_address {
                return Err(format!("Bluetooth pairing is already active for {active}"));
            }
            inner.pairing_address = Some(address.clone());
        }
        let state = self.clone();
        std::mem::drop(tokio::task::spawn_blocking(move || {
            let result = state.pair_blocking(&address, bridge.clone());
            let pending = state.inner.lock().ok().and_then(|mut inner| {
                if inner.pairing_address.as_deref() == Some(address.as_str()) {
                    inner.pairing_address = None;
                }
                inner.pending_pairing.take()
            });
            if let Some(pending) = pending {
                let _ = pending.decision.send(false);
            }
            match result {
                Ok(()) => {
                    bridge.emit("bluetooth.pair_complete", json!({ "address": address }));
                }
                Err(error) => {
                    log_native(&format!("Bluetooth pairing failed for {address}: {error}"));
                    bridge.emit(
                        "bluetooth.pairing_cancelled",
                        json!({ "address": address, "error": error }),
                    );
                }
            }
        }));
        Ok(())
    }

    fn pair_blocking(&self, address: &str, bridge: BridgeServer) -> Result<(), String> {
        if self.try_pair_winrt(address, bridge)? {
            return Ok(());
        }
        self.ensure_radio()?;
        let mut info = self.find_device(address)?;
        let code = unsafe {
            BluetoothAuthenticateDeviceEx(
                None,
                None,
                &mut info,
                None,
                AUTHENTICATION_REQUIREMENTS(0),
            )
        };
        if code != 0 {
            return Err(format!(
                "Bluetooth pairing failed with Windows error {code}"
            ));
        }
        Ok(())
    }

    fn resolve_pairing(&self, accepted: bool) -> Result<(), String> {
        let pending = self
            .inner
            .lock()
            .map_err(|_| "Bluetooth state is poisoned".to_string())?
            .pending_pairing
            .take()
            .ok_or_else(|| "No Bluetooth pairing confirmation is pending".to_string())?;
        pending
            .decision
            .send(accepted)
            .map_err(|_| format!("Pairing confirmation for {} expired", pending.address))
    }

    fn try_pair_winrt(&self, address: &str, bridge: BridgeServer) -> Result<bool, String> {
        let id = self
            .inner
            .lock()
            .map_err(|_| "Bluetooth state is poisoned".to_string())?
            .winrt_ids
            .iter()
            .find_map(|(known_address, ids)| {
                known_address
                    .eq_ignore_ascii_case(address)
                    .then(|| {
                        ids.iter()
                            .filter(|id| !id.to_ascii_lowercase().contains("bluetoothle"))
                            .min()
                            .cloned()
                    })
                    .flatten()
            });
        let Some(id) = id else { return Ok(false) };
        let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        let id = windows::core::HSTRING::from(id);
        let information = DeviceInformation::CreateFromIdAsync(&id)
            .and_then(|operation| operation.get())
            .map_err(|error| format!("Unable to open Bluetooth device {address}: {error}"))?;
        let pairing = information
            .Pairing()
            .map_err(|error| format!("Unable to read Bluetooth pairing state: {error}"))?;
        if pairing
            .IsPaired()
            .map_err(|error| format!("Unable to read Bluetooth pairing state: {error}"))?
        {
            return Ok(true);
        }
        let custom = pairing
            .Custom()
            .map_err(|error| format!("Unable to create custom Bluetooth pairing: {error}"))?;
        let event_state = self.clone();
        let event_bridge = bridge.clone();
        let event_address = address.to_string();
        let event_name = information
            .Name()
            .map(|name| name.to_string())
            .unwrap_or_else(|_| address.to_string());
        let requested = TypedEventHandler::<
            DeviceInformationCustomPairing,
            DevicePairingRequestedEventArgs,
        >::new(move |_sender, args| {
            let Some(args) = args.as_ref() else {
                return Ok(());
            };
            let kind = args.PairingKind()?;
            if kind == DevicePairingKinds::ProvidePin {
                return args.AcceptWithPin(&HSTRING::from("0000"));
            }
            if kind == DevicePairingKinds::ConfirmPinMatch {
                let pin = args.Pin()?.to_string();
                let deferral = args.GetDeferral()?;
                let (decision, response) = sync_channel(1);
                let registered = event_state
                    .inner
                    .lock()
                    .map(|mut inner| {
                        if inner.pending_pairing.is_some() {
                            false
                        } else {
                            inner.pending_pairing = Some(PendingPairing {
                                address: event_address.clone(),
                                decision,
                            });
                            true
                        }
                    })
                    .unwrap_or(false);
                if registered {
                    event_bridge.emit(
                        "bluetooth.pairing_request",
                        json!({
                            "address": event_address,
                            "name": event_name,
                            "pin": pin,
                        }),
                    );
                }
                let accepted = registered
                    && response
                        .recv_timeout(Duration::from_secs(60))
                        .unwrap_or(false);
                if let Ok(mut inner) = event_state.inner.lock() {
                    if inner
                        .pending_pairing
                        .as_ref()
                        .is_some_and(|pending| pending.address == event_address)
                    {
                        inner.pending_pairing = None;
                    }
                }
                let accept_result = if accepted { args.Accept() } else { Ok(()) };
                if !accepted {
                    event_bridge.emit(
                        "bluetooth.pairing_cancelled",
                        json!({ "address": event_address }),
                    );
                }
                let complete_result = deferral.Complete();
                accept_result?;
                return complete_result;
            }
            args.Accept()
        });
        let token = custom
            .PairingRequested(&requested)
            .map_err(|error| format!("Unable to register custom Bluetooth pairing: {error}"))?;
        let kinds = DevicePairingKinds::ConfirmOnly
            | DevicePairingKinds::DisplayPin
            | DevicePairingKinds::ProvidePin
            | DevicePairingKinds::ConfirmPinMatch;
        let operation = custom.PairAsync(kinds);
        let result = operation
            .and_then(|operation| operation.get())
            .map_err(|error| format!("Bluetooth pairing failed: {error}"));
        let _ = custom.RemovePairingRequested(token);
        let result = result?;
        match result
            .Status()
            .map_err(|error| format!("Unable to read Bluetooth pairing result: {error}"))?
        {
            DevicePairingResultStatus::Paired | DevicePairingResultStatus::AlreadyPaired => {
                Ok(true)
            }
            status => Err(format!(
                "Bluetooth pairing failed with Windows status {status:?} ({})",
                status.0,
            )),
        }
    }

    fn find_device(&self, address: &str) -> Result<BLUETOOTH_DEVICE_INFO, String> {
        let devices = self.enumerate_devices()?;
        if !devices
            .iter()
            .any(|device| device.get("address").and_then(Value::as_str) == Some(address))
        {
            return Err(format!("Bluetooth device {address} was not found"));
        }
        let target = parse_address(address)?;
        let mut info = BLUETOOTH_DEVICE_INFO {
            dwSize: std::mem::size_of::<BLUETOOTH_DEVICE_INFO>() as u32,
            Address: target,
            ..Default::default()
        };
        let result = unsafe { BluetoothGetDeviceInfo(None, &mut info) };
        if result != 0 {
            return Err(format!(
                "Unable to read Bluetooth device {address}: {result}"
            ));
        }
        Ok(info)
    }

    fn remove(&self, address: &str) -> Result<(), String> {
        let target = parse_address(address)?;
        let result = unsafe { BluetoothRemoveDevice(&target) };
        if result != 0 && result != 1168 {
            return Err(format!(
                "Unable to remove Bluetooth device {address}: {result}"
            ));
        }
        Ok(())
    }

    fn try_remove_winrt(&self, address: &str) -> Result<bool, String> {
        let ids = self
            .inner
            .lock()
            .map_err(|_| "Bluetooth state is poisoned".to_string())?
            .winrt_ids
            .iter()
            .find_map(|(known_address, ids)| {
                known_address
                    .eq_ignore_ascii_case(address)
                    .then(|| ids.iter().cloned().collect::<Vec<_>>())
            })
            .unwrap_or_default();
        if ids.is_empty() {
            return Ok(false);
        }
        let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        let mut removed = false;
        for id in ids {
            let id = windows::core::HSTRING::from(id);
            let information = match DeviceInformation::CreateFromIdAsync(&id)
                .and_then(|operation| operation.get())
            {
                Ok(information) => information,
                Err(error) => {
                    log_native(&format!(
                        "Skipping unavailable Bluetooth identity for {address}: {error}"
                    ));
                    continue;
                }
            };
            let pairing = information
                .Pairing()
                .map_err(|error| format!("Unable to read Bluetooth pairing state: {error}"))?;
            if !pairing
                .IsPaired()
                .map_err(|error| format!("Unable to read Bluetooth pairing state: {error}"))?
            {
                continue;
            }
            let result = pairing
                .UnpairAsync()
                .and_then(|operation| operation.get())
                .map_err(|error| format!("Bluetooth unpairing failed: {error}"))?;
            if !result.Status().map(|status| status.0 == 0).unwrap_or(false) {
                return Err("Bluetooth unpairing failed".to_string());
            }
            removed = true;
        }
        Ok(removed)
    }

    fn start_servers(&self, bridge: BridgeServer) -> Result<(), String> {
        let should_start = self
            .inner
            .lock()
            .map(|mut inner| {
                if inner.servers_started {
                    false
                } else {
                    inner.servers_started = true;
                    true
                }
            })
            .map_err(|_| "Bluetooth state is poisoned".to_string())?;
        if !should_start {
            return Ok(());
        }
        if let Err(error) = startup_winsock() {
            if let Ok(mut inner) = self.inner.lock() {
                inner.servers_started = false;
            }
            return Err(error);
        }
        let probe_listener = match bind_server(PROBE_CHANNEL) {
            Ok(listener) => Some(listener),
            Err(error) => {
                log_native(&format!(
                    "RFCOMM probe listener deferred requested_channel={PROBE_CHANNEL}: {error}"
                ));
                None
            }
        };
        let state = self.clone();
        let first_bridge = bridge.clone();
        thread::spawn(move || accept_loop(state, first_bridge, RFCOMM_SERVER_CHANNEL, false, None));
        let state = self.clone();
        thread::spawn(move || accept_loop(state, bridge, PROBE_CHANNEL, true, probe_listener));
        Ok(())
    }

    fn connect_client(&self, address: &str, channel: u32) -> Result<(), String> {
        startup_winsock()?;
        self.disconnect_client();
        let generation = self.route_generation();
        let address = address.to_string();
        let socket = connect_socket(&address, channel)?;
        let bridge = self
            .inner
            .lock()
            .map_err(|_| "Bluetooth state is poisoned".to_string())?
            .bridge
            .clone();
        let activated = {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "Bluetooth state is poisoned".to_string())?;
            if inner.route_generation != generation {
                false
            } else {
                inner.client_socket = Some(socket);
                inner.client_address = address.clone();
                if let Some(bridge) = &bridge {
                    bridge.emit("rfcomm.client.connected", json!({ "address": address }));
                }
                true
            }
        };
        if !activated {
            close_socket(socket);
            return Err("RFCOMM connection became stale before activation".to_string());
        }
        let state = self.clone();
        thread::spawn(move || {
            client_read_loop(state, bridge, socket, address.to_string(), generation)
        });
        Ok(())
    }

    async fn write_server(&self, connection_id: &str, data: Vec<u8>) -> Result<(), String> {
        let socket = self
            .inner
            .lock()
            .map_err(|_| "Bluetooth state is poisoned".to_string())?
            .server_connections
            .get(connection_id)
            .copied()
            .ok_or_else(|| format!("RFCOMM connection {connection_id} is unavailable"))?;
        tokio::task::spawn_blocking(move || send_all(socket, &data))
            .await
            .map_err(|error| format!("RFCOMM server writer stopped: {error}"))??;
        let still_current = self
            .inner
            .lock()
            .map_err(|_| "Bluetooth state is poisoned".to_string())?
            .server_connections
            .get(connection_id)
            .is_some_and(|current| *current == socket);
        if !still_current {
            return Err(format!(
                "RFCOMM connection {connection_id} changed during write"
            ));
        }
        Ok(())
    }

    fn disconnect_server(&self, connection_id: &str) -> Result<(), String> {
        let (socket, bridge) = self
            .inner
            .lock()
            .map(|mut inner| {
                (
                    inner.server_connections.remove(connection_id),
                    inner.bridge.clone(),
                )
            })
            .map_err(|_| "Bluetooth state is poisoned".to_string())?;
        let socket =
            socket.ok_or_else(|| format!("RFCOMM connection {connection_id} is unavailable"))?;
        thread::spawn(move || close_socket(socket));
        if let Some(bridge) = bridge {
            bridge.emit(
                "rfcomm.server.disconnected",
                json!({ "connectionId": connection_id }),
            );
        }
        Ok(())
    }

    async fn write_client(&self, data: Vec<u8>) -> Result<(), String> {
        let (socket, generation, address, bridge) = self
            .inner
            .lock()
            .map(|inner| {
                (
                    inner.client_socket,
                    inner.route_generation,
                    inner.client_address.clone(),
                    inner.bridge.clone(),
                )
            })
            .map_err(|_| "Bluetooth state is poisoned".to_string())?;
        let socket = socket.ok_or_else(|| "RFCOMM client is not connected".to_string())?;
        let send_result = tokio::task::spawn_blocking(move || send_all(socket, &data))
            .await
            .map_err(|error| format!("RFCOMM client writer stopped: {error}"))?;
        if let Err(error) = send_result {
            let removed = self
                .inner
                .lock()
                .map(|mut inner| {
                    if inner.client_socket == Some(socket) && inner.route_generation == generation {
                        inner.client_socket = None;
                        inner.client_address.clear();
                        true
                    } else {
                        false
                    }
                })
                .unwrap_or(false);
            if removed {
                close_socket(socket);
                if let Some(bridge) = bridge {
                    bridge.emit("rfcomm.client.disconnected", json!({ "address": address }));
                }
            }
            return Err(error);
        }
        let still_current = self
            .inner
            .lock()
            .map(|inner| {
                inner.client_socket == Some(socket) && inner.route_generation == generation
            })
            .map_err(|_| "Bluetooth state is poisoned".to_string())?;
        if !still_current {
            return Err("RFCOMM client route changed during write".to_string());
        }
        Ok(())
    }

    fn disconnect_client(&self) {
        let socket = self.inner.lock().ok().and_then(|mut inner| {
            inner.route_generation = if inner.route_generation == u64::MAX {
                0
            } else {
                inner.route_generation + 1
            };
            inner.client_address.clear();
            inner.client_socket.take()
        });
        if let Some(socket) = socket {
            thread::spawn(move || close_socket(socket));
        }
    }
}

fn register_service(channel: u32) -> Result<(), String> {
    let mut service_name: Vec<u16> = "Nocturne SPP".encode_utf16().chain(Some(0)).collect();
    let mut service_class = GUID::from_u128(0x0000_1101_0000_1000_8000_0080_5f9b_34fb);
    let mut address = SOCKADDR_BTH {
        addressFamily: AF_BTH,
        btAddr: 0,
        serviceClassId: service_class,
        port: channel,
    };
    let mut socket_address = CSADDR_INFO {
        LocalAddr: SOCKET_ADDRESS {
            lpSockaddr: (&mut address as *mut SOCKADDR_BTH).cast::<SOCKADDR>(),
            iSockaddrLength: std::mem::size_of::<SOCKADDR_BTH>() as i32,
        },
        RemoteAddr: SOCKET_ADDRESS::default(),
        iSocketType: SOCK_STREAM.0,
        iProtocol: BTHPROTO_RFCOMM as i32,
    };
    let query = WSAQUERYSETW {
        dwSize: std::mem::size_of::<WSAQUERYSETW>() as u32,
        lpszServiceInstanceName: windows::core::PWSTR(service_name.as_mut_ptr()),
        lpServiceClassId: &mut service_class,
        dwNameSpace: NS_BTH,
        dwNumberOfCsAddrs: 1,
        lpcsaBuffer: &mut socket_address,
        ..Default::default()
    };
    let result = unsafe { WSASetServiceW(&query, RNRSERVICE_REGISTER, 0) };
    if result != 0 {
        return Err(format!(
            "Unable to register the Nocturne SPP service (Winsock error {})",
            unsafe { WSAGetLastError().0 }
        ));
    }
    Ok(())
}

fn monitor_loop(state: WindowsBluetoothState) {
    loop {
        thread::sleep(Duration::from_secs(2));
        let (was_powered, previous_radio, previous_address, bridge) = match state.inner.lock() {
            Ok(inner) => (
                inner.radio.is_some(),
                inner.radio,
                inner.radio_address.clone(),
                inner.bridge.clone(),
            ),
            Err(_) => continue,
        };
        let is_powered = state.ensure_radio().is_ok();
        let (current_radio, current_address) = state
            .inner
            .lock()
            .map(|inner| (inner.radio, inner.radio_address.clone()))
            .unwrap_or((None, String::new()));
        let radio_changed = previous_radio != current_radio;
        if was_powered != is_powered || radio_changed || previous_address != current_address {
            state.reset_routes();
            if is_powered && radio_changed {
                if let Err(error) = state.set_discoverable(true) {
                    eprintln!("Unable to restore Bluetooth discoverability: {error}");
                }
                if let Err(error) = state.set_pairable(true) {
                    eprintln!("Unable to restore Bluetooth pairability: {error}");
                }
            }
            if let Some(bridge) = bridge {
                bridge.emit("bluetooth.adapter_status", state.status());
            }
        }
    }
}

fn accept_loop(
    state: WindowsBluetoothState,
    bridge: BridgeServer,
    channel: u32,
    probe: bool,
    initial_listener: Option<(SOCKET, u32)>,
) {
    let (mut listener, mut bound_channel) = initial_listener.unwrap_or_else(|| loop {
        match bind_server(channel) {
            Ok(listener) => break listener,
            Err(error) => {
                eprintln!("RFCOMM channel {channel} is unavailable: {error}");
                log_native(&format!(
                    "RFCOMM listener bind retry requested_channel={channel} probe={probe}: {error}"
                ));
                thread::sleep(Duration::from_secs(2));
            }
        }
    });
    if !probe {
        if let Err(error) = register_service(bound_channel) {
            eprintln!("RFCOMM service advertisement unavailable: {error}");
        }
    }
    log_native(&format!(
        "RFCOMM listener ready requested_channel={channel} bound_channel={bound_channel} probe={probe}"
    ));
    loop {
        let generation = state.route_generation();
        let mut address = SOCKADDR_BTH::default();
        let mut length = std::mem::size_of::<SOCKADDR_BTH>() as i32;
        let accepted = unsafe {
            accept(
                listener,
                Some((&mut address as *mut SOCKADDR_BTH).cast::<SOCKADDR>()),
                Some(&mut length),
            )
        };
        let socket = match accepted {
            Ok(socket) => socket,
            Err(_) => {
                unsafe {
                    closesocket(listener);
                }
                (listener, bound_channel) = loop {
                    match bind_server(channel) {
                        Ok(listener) => break listener,
                        Err(error) => {
                            eprintln!("RFCOMM channel {channel} is unavailable: {error}");
                            log_native(&format!(
                                "RFCOMM listener rebind retry requested_channel={channel} probe={probe}: {error}"
                            ));
                            thread::sleep(Duration::from_secs(2));
                        }
                    }
                };
                if !probe {
                    if let Err(error) = register_service(bound_channel) {
                        eprintln!("RFCOMM service advertisement unavailable: {error}");
                    }
                }
                continue;
            }
        };
        if !state.is_route_generation(generation) {
            close_socket(socket);
            continue;
        }
        let remote = format_address(address.btAddr);
        if probe {
            log_native(&format!("RFCOMM probe accepted from {remote}"));
            bridge.emit("bluetooth.acl_connected", json!({ "address": remote }));
            thread::sleep(PROBE_HOLD);
            close_socket(socket);
            if !state.is_route_generation(generation) {
                continue;
            }
            if let Err(error) = state.connect_client(&remote, 2) {
                let message = format!("RFCOMM probe callback to {remote} failed: {error}");
                eprintln!("{message}");
                log_native(&message);
            } else {
                log_native(&format!(
                    "RFCOMM probe callback connected to {remote} channel 2"
                ));
            }
            continue;
        }
        let connection_id = Uuid::new_v4().to_string();
        let activated = state
            .inner
            .lock()
            .map(|mut inner| {
                if inner.route_generation != generation {
                    false
                } else {
                    inner
                        .server_connections
                        .insert(connection_id.clone(), socket);
                    bridge.emit(
                        "rfcomm.server.connected",
                        json!({ "address": remote, "connectionId": connection_id }),
                    );
                    true
                }
            })
            .unwrap_or(false);
        if !activated {
            close_socket(socket);
            continue;
        }
        let state_clone = state.clone();
        let bridge_clone = bridge.clone();
        thread::spawn(move || {
            server_read_loop(
                state_clone,
                bridge_clone,
                socket,
                connection_id,
                remote,
                generation,
            )
        });
    }
}

fn server_read_loop(
    state: WindowsBluetoothState,
    bridge: BridgeServer,
    socket: SOCKET,
    connection_id: String,
    address: String,
    generation: u64,
) {
    let mut buffer = vec![0u8; 4096];
    loop {
        let read = unsafe { recv(socket, &mut buffer, SEND_RECV_FLAGS(0)) };
        if read <= 0 {
            break;
        }
        if state.is_route_generation(generation) {
            bridge.emit(
                "rfcomm.server.data",
                json!({ "connectionId": connection_id, "data": buffer[..read as usize].to_vec() }),
            );
        }
    }
    let should_emit = if state.is_route_generation(generation) {
        state
            .inner
            .lock()
            .map(|mut inner| inner.server_connections.remove(&connection_id).is_some())
            .unwrap_or(false)
    } else {
        false
    };
    close_socket(socket);
    if should_emit {
        bridge.emit(
            "rfcomm.server.disconnected",
            json!({ "connectionId": connection_id, "address": address }),
        );
    }
}

fn client_read_loop(
    state: WindowsBluetoothState,
    bridge: Option<BridgeServer>,
    socket: SOCKET,
    address: String,
    generation: u64,
) {
    let mut buffer = vec![0u8; 4096];
    loop {
        let read = unsafe { recv(socket, &mut buffer, SEND_RECV_FLAGS(0)) };
        if read <= 0 {
            break;
        }
        if state.is_route_generation(generation) {
            if let Some(bridge) = &bridge {
                bridge.emit(
                    "rfcomm.client.data",
                    json!({ "data": buffer[..read as usize].to_vec() }),
                );
            }
        }
    }
    let should_emit = state
        .inner
        .lock()
        .map(|mut inner| {
            if inner.route_generation == generation && inner.client_socket == Some(socket) {
                inner.client_socket = None;
                true
            } else {
                false
            }
        })
        .unwrap_or(false);
    close_socket(socket);
    if should_emit {
        if let Some(bridge) = bridge {
            bridge.emit("rfcomm.client.disconnected", json!({ "address": address }));
        }
    }
}

fn close_socket(socket: SOCKET) {
    unsafe {
        let _ = closesocket(socket);
    }
}

fn bind_server(channel: u32) -> Result<(SOCKET, u32), String> {
    let socket = unsafe { socket(AF_BTH as i32, SOCK_STREAM, BTHPROTO_RFCOMM as i32) }
        .map_err(|error| format!("RFCOMM socket creation failed: {error}"))?;
    if let Err(error) = set_socket_security(socket) {
        unsafe {
            closesocket(socket);
        }
        return Err(error);
    }
    let mut address = SOCKADDR_BTH {
        addressFamily: AF_BTH,
        btAddr: 0,
        serviceClassId: GUID::zeroed(),
        port: channel,
    };
    let result = unsafe {
        bind(
            socket,
            (&address as *const SOCKADDR_BTH).cast::<SOCKADDR>(),
            std::mem::size_of::<SOCKADDR_BTH>() as i32,
        )
    };
    if result != 0 {
        let error = unsafe { WSAGetLastError().0 };
        unsafe {
            closesocket(socket);
        }
        if channel == RFCOMM_SERVER_CHANNEL && matches!(error, 10013 | 10048) {
            eprintln!(
                "RFCOMM channel {channel} is reserved by Windows ({error}); using an automatic server channel"
            );
            return bind_server_auto();
        }
        return Err(format!("RFCOMM channel {channel} bind failed: {error}"));
    }
    if unsafe { listen(socket, 4) } != 0 {
        let error = unsafe { WSAGetLastError().0 };
        unsafe {
            closesocket(socket);
        }
        return Err(format!("RFCOMM channel {channel} listen failed: {error}"));
    }
    let mut length = std::mem::size_of::<SOCKADDR_BTH>() as i32;
    let result = unsafe {
        getsockname(
            socket,
            (&mut address as *mut SOCKADDR_BTH).cast::<SOCKADDR>(),
            &mut length,
        )
    };
    if result != 0 {
        let error = unsafe { WSAGetLastError().0 };
        unsafe {
            closesocket(socket);
        }
        return Err(format!("RFCOMM channel {channel} lookup failed: {error}"));
    }
    Ok((socket, address.port))
}

fn bind_server_auto() -> Result<(SOCKET, u32), String> {
    let socket = unsafe { socket(AF_BTH as i32, SOCK_STREAM, BTHPROTO_RFCOMM as i32) }
        .map_err(|error| format!("RFCOMM socket creation failed: {error}"))?;
    if let Err(error) = set_socket_security(socket) {
        unsafe {
            closesocket(socket);
        }
        return Err(error);
    }
    let mut address = SOCKADDR_BTH {
        addressFamily: AF_BTH,
        btAddr: 0,
        serviceClassId: GUID::zeroed(),
        port: u32::MAX,
    };
    let result = unsafe {
        bind(
            socket,
            (&address as *const SOCKADDR_BTH).cast::<SOCKADDR>(),
            std::mem::size_of::<SOCKADDR_BTH>() as i32,
        )
    };
    if result != 0 {
        let error = unsafe { WSAGetLastError().0 };
        unsafe {
            closesocket(socket);
        }
        return Err(format!("RFCOMM automatic bind failed: {error}"));
    }
    if unsafe { listen(socket, 4) } != 0 {
        let error = unsafe { WSAGetLastError().0 };
        unsafe {
            closesocket(socket);
        }
        return Err(format!("RFCOMM automatic listen failed: {error}"));
    }
    let mut length = std::mem::size_of::<SOCKADDR_BTH>() as i32;
    let result = unsafe {
        getsockname(
            socket,
            (&mut address as *mut SOCKADDR_BTH).cast::<SOCKADDR>(),
            &mut length,
        )
    };
    if result != 0 {
        let error = unsafe { WSAGetLastError().0 };
        unsafe {
            closesocket(socket);
        }
        return Err(format!("RFCOMM automatic channel lookup failed: {error}"));
    }
    Ok((socket, address.port))
}

fn connect_socket(address: &str, channel: u32) -> Result<SOCKET, String> {
    let socket = unsafe { socket(AF_BTH as i32, SOCK_STREAM, BTHPROTO_RFCOMM as i32) }
        .map_err(|error| format!("RFCOMM socket creation failed: {error}"))?;
    if let Err(error) = set_socket_security(socket) {
        unsafe {
            closesocket(socket);
        }
        return Err(error);
    }
    let address_value = match parse_address(address) {
        Ok(address) => address,
        Err(error) => {
            unsafe {
                closesocket(socket);
            }
            return Err(error);
        }
    };
    let sockaddr = SOCKADDR_BTH {
        addressFamily: AF_BTH,
        btAddr: unsafe { address_value.Anonymous.ullLong },
        serviceClassId: GUID::zeroed(),
        port: channel,
    };
    let result = unsafe {
        connect(
            socket,
            (&sockaddr as *const SOCKADDR_BTH).cast::<SOCKADDR>(),
            std::mem::size_of::<SOCKADDR_BTH>() as i32,
        )
    };
    if result != 0 {
        let error = unsafe { WSAGetLastError().0 };
        unsafe {
            closesocket(socket);
        }
        return Err(format!(
            "RFCOMM connection to {address} channel {channel} failed: {error}"
        ));
    }
    Ok(socket)
}

fn set_socket_security(socket: SOCKET) -> Result<(), String> {
    let enabled = 1i32.to_ne_bytes();
    let auth = unsafe {
        setsockopt(
            socket,
            SOL_RFCOMM as i32,
            SO_BTH_AUTHENTICATE as i32,
            Some(&enabled),
        )
    };
    let encrypt = unsafe {
        setsockopt(
            socket,
            SOL_RFCOMM as i32,
            SO_BTH_ENCRYPT as i32,
            Some(&enabled),
        )
    };
    let send_timeout = unsafe {
        setsockopt(
            socket,
            SOL_SOCKET,
            SO_SNDTIMEO,
            Some(&5000u32.to_ne_bytes()),
        )
    };
    if auth != 0 || encrypt != 0 || send_timeout != 0 {
        return Err("Unable to configure authenticated encrypted RFCOMM".to_string());
    }
    Ok(())
}

fn send_all(socket: SOCKET, data: &[u8]) -> Result<(), String> {
    let mut offset = 0;
    while offset < data.len() {
        let sent = unsafe { send(socket, &data[offset..], SEND_RECV_FLAGS(0)) };
        if sent <= 0 {
            return Err(format!(
                "RFCOMM write failed with Winsock error {}",
                unsafe { WSAGetLastError().0 }
            ));
        }
        offset += sent as usize;
    }
    Ok(())
}

fn startup_winsock() -> Result<(), String> {
    static STARTED: std::sync::Once = std::sync::Once::new();
    static mut RESULT: i32 = 0;
    STARTED.call_once(|| unsafe {
        let mut data = WSADATA::default();
        RESULT = WSAStartup(0x0202, &mut data);
    });
    let result = unsafe { RESULT };
    if result == 0 {
        Ok(())
    } else {
        Err(format!("WSAStartup failed: {result}"))
    }
}

fn log_native(message: &str) {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Nocturne")
        .join("Connector")
        .join("logs");
    if fs::create_dir_all(&base).is_err() {
        return;
    }
    let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(base.join("host.log"))
    else {
        return;
    };
    let _ = writeln!(file, "{message}");
}

fn device_json(info: &BLUETOOTH_DEVICE_INFO) -> Value {
    let address = unsafe { info.Address.Anonymous.ullLong };
    let name = String::from_utf16_lossy(&info.szName)
        .trim_end_matches('\0')
        .to_string();
    json!({
        "address": format_address(address),
        "name": if name.is_empty() { "Unknown Device" } else { &name },
        "paired": info.fRemembered.0 != 0 || info.fAuthenticated.0 != 0,
        "connected": info.fConnected.0 != 0,
        "trusted": info.fAuthenticated.0 != 0,
        "rssi": -100,
        "icon": "computer",
    })
}

fn merge_device(existing: Option<&Value>, incoming: Value) -> Value {
    let Some(existing) = existing.and_then(Value::as_object) else {
        return incoming;
    };
    let Some(incoming) = incoming.as_object() else {
        return Value::Object(existing.clone());
    };
    let mut merged = incoming.clone();
    let address = incoming
        .get("address")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let incoming_name = incoming
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let existing_name = existing
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if device_name_is_unknown(incoming_name, address)
        && !device_name_is_unknown(existing_name, address)
    {
        merged.insert("name".to_string(), Value::String(existing_name.to_string()));
    }
    for key in ["paired", "trusted", "connected"] {
        let value = existing.get(key).and_then(Value::as_bool).unwrap_or(false)
            || incoming.get(key).and_then(Value::as_bool).unwrap_or(false);
        merged.insert(key.to_string(), Value::Bool(value));
    }
    Value::Object(merged)
}

fn device_name_is_unknown(name: &str, address: &str) -> bool {
    let normalized_name = name.trim().to_ascii_lowercase();
    if normalized_name.is_empty() || normalized_name == "unknown device" {
        return true;
    }
    let normalized_address = address.to_ascii_lowercase();
    normalized_name == normalized_address
        || normalized_name == format!("bluetooth {normalized_address}")
        || normalized_name == format!("bluetooth {}", normalized_address.replace(':', "-"))
}

fn resolve_winrt_device(
    information: &DeviceInformation,
    low_energy: bool,
) -> Option<(String, Value)> {
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    let id = information.Id().ok()?;
    let (address, name, connected) = if low_energy {
        let device = BluetoothLEDevice::FromIdAsync(&id).ok()?.get().ok()?;
        (
            device.BluetoothAddress().ok()?,
            device.Name().ok().map(|name| name.to_string()),
            device.ConnectionStatus().ok() == Some(BluetoothConnectionStatus::Connected),
        )
    } else {
        let device = BluetoothDevice::FromIdAsync(&id).ok()?.get().ok()?;
        (
            device.BluetoothAddress().ok()?,
            device.Name().ok().map(|name| name.to_string()),
            device.ConnectionStatus().ok() == Some(BluetoothConnectionStatus::Connected),
        )
    };
    if address == 0 {
        return None;
    }
    let name = name
        .filter(|name| !name.trim().is_empty())
        .or_else(|| {
            information
                .Name()
                .ok()
                .map(|name| name.to_string())
                .filter(|name| !name.trim().is_empty())
        })
        .unwrap_or_else(|| "Unknown Device".to_string());
    let paired = information
        .Pairing()
        .ok()
        .and_then(|pairing| pairing.IsPaired().ok())
        .unwrap_or(false);
    Some((
        format_address(address),
        json!({
            "address": format_address(address),
            "name": name,
            "paired": paired,
            "connected": connected,
            "trusted": paired,
            "rssi": -100,
            "icon": "computer",
        }),
    ))
}

fn parse_address(value: &str) -> Result<BLUETOOTH_ADDRESS, String> {
    let hex: String = value
        .chars()
        .filter(|character| *character != ':')
        .collect();
    if hex.len() != 12 || !hex.chars().all(|character| character.is_ascii_hexdigit()) {
        return Err(format!("Invalid Bluetooth address: {value}"));
    }
    let parsed = u64::from_str_radix(&hex, 16).map_err(|error| error.to_string())?;
    let mut address = BLUETOOTH_ADDRESS::default();
    address.Anonymous.ullLong = parsed;
    Ok(address)
}

fn format_address(address: u64) -> String {
    format!(
        "{:02X}:{:02X}:{:02X}:{:02X}:{:02X}:{:02X}",
        (address >> 40) & 0xff,
        (address >> 32) & 0xff,
        (address >> 24) & 0xff,
        (address >> 16) & 0xff,
        (address >> 8) & 0xff,
        address & 0xff,
    )
}

fn required_string(params: &Value, key: &str) -> Result<String, String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("Missing native Bluetooth parameter {key}"))
}

fn bytes_param(params: &Value, key: &str) -> Result<Vec<u8>, String> {
    let value = params
        .get(key)
        .ok_or_else(|| format!("Missing binary parameter {key}"))?;
    if let Some(array) = value.as_array() {
        return array
            .iter()
            .map(|value| {
                value
                    .as_u64()
                    .and_then(|value| u8::try_from(value).ok())
                    .ok_or_else(|| format!("Invalid byte in {key}"))
            })
            .collect();
    }
    if let Some(encoded) = value.as_str() {
        return base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|error| format!("Invalid base64 in {key}: {error}"));
    }
    Err(format!("Native parameter {key} is not binary"))
}

#[cfg(test)]
mod tests {
    use super::merge_device;
    use serde_json::json;

    #[test]
    fn device_merge_preserves_classic_name_and_pairing_in_either_order() {
        let classic = json!({
            "address": "30:E3:D6:00:B5:5F",
            "name": "Nocturne (Q01S)",
            "paired": true,
            "trusted": true,
            "connected": false,
        });
        let low_energy = json!({
            "address": "30:E3:D6:00:B5:5F",
            "name": "Bluetooth 30:e3:d6:00:b5:5f",
            "paired": false,
            "trusted": false,
            "connected": true,
        });

        let classic_first = merge_device(Some(&classic), low_energy.clone());
        let low_energy_first = merge_device(Some(&low_energy), classic);
        for merged in [classic_first, low_energy_first] {
            assert_eq!(merged["name"], "Nocturne (Q01S)");
            assert_eq!(merged["paired"], true);
            assert_eq!(merged["trusted"], true);
            assert_eq!(merged["connected"], true);
        }
    }
}
