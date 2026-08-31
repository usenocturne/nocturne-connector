use rmp_serde::{from_slice, to_vec_named};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io;
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{broadcast, mpsc, watch};
use uuid::Uuid;

use crate::native::NativeServices;

const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeRequest {
    pub r#type: String,
    pub id: u64,
    pub token: String,
    #[serde(default)]
    pub generation: u64,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeResponse {
    pub r#type: String,
    pub id: u64,
    pub generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<BridgeErrorPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeErrorPayload {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeEvent {
    pub r#type: String,
    pub topic: String,
    pub data: Value,
    #[serde(default)]
    pub generation: u64,
}

#[derive(Debug, Error)]
pub enum BridgeError {
    #[error("invalid bridge frame: {0}")]
    InvalidFrame(String),
    #[error("bridge I/O failed: {0}")]
    Io(#[from] io::Error),
    #[error("bridge serialization failed: {0}")]
    Serialization(String),
}

#[derive(Clone)]
pub struct BridgeServer {
    token: Arc<String>,
    events: broadcast::Sender<BridgeEvent>,
    native: Arc<NativeServices>,
    next_connection_id: Arc<AtomicU64>,
    active_connection: watch::Sender<u64>,
}

impl BridgeServer {
    pub fn new(token: String) -> Self {
        let (events, _) = broadcast::channel(128);
        let (active_connection, _) = watch::channel(0);
        Self {
            token: Arc::new(token),
            events,
            native: NativeServices::new(),
            next_connection_id: Arc::new(AtomicU64::new(1)),
            active_connection,
        }
    }

    pub fn pipe_name() -> String {
        format!(r"\\.\pipe\NocturneConnector-{}", Uuid::new_v4())
    }

    pub fn subscribe(&self) -> broadcast::Receiver<BridgeEvent> {
        self.events.subscribe()
    }

    pub fn emit(&self, topic: impl Into<String>, data: Value) {
        let _ = self.events.send(BridgeEvent {
            r#type: "event".to_string(),
            topic: topic.into(),
            data,
            generation: 0,
        });
    }

    pub async fn start_native(&self) {
        self.native.start(self.clone()).await;
    }

    pub fn reset_after_sidecar_exit(&self) {
        let connection_id = self.next_connection_id.fetch_add(1, Ordering::Relaxed);
        let _ = self.active_connection.send(connection_id);
        log_bridge(&format!(
            "Reset native routes after sidecar exit connection_id={connection_id}"
        ));
        let native = Arc::clone(&self.native);
        std::thread::spawn(move || native.reset_routes());
    }

    pub async fn serve(&self) -> Result<(), BridgeError> {
        #[cfg(windows)]
        {
            return self.serve_named_pipe().await;
        }
        #[cfg(not(windows))]
        {
            Ok(())
        }
    }

    #[cfg(windows)]
    async fn serve_named_pipe(&self) -> Result<(), BridgeError> {
        let pipe_name = std::env::var("NOCTURNE_HOST_PIPE")
            .map_err(|_| BridgeError::InvalidFrame("NOCTURNE_HOST_PIPE is missing".to_string()))?;
        loop {
            let server = create_user_pipe(&pipe_name).map_err(BridgeError::Io)?;
            server.connect().await.map_err(BridgeError::Io)?;
            let connection_id = self.next_connection_id.fetch_add(1, Ordering::Relaxed);
            let _ = self.active_connection.send(connection_id);
            log_bridge(&format!("Named-pipe client connected id={connection_id}"));
            let bridge = self.clone();
            let active_connection = self.active_connection.subscribe();
            tokio::spawn(async move {
                let (reader, writer) = tokio::io::split(server);
                match bridge
                    .serve_connection(reader, writer, connection_id, active_connection)
                    .await
                {
                    Ok(()) => log_bridge("Named-pipe client ended normally"),
                    Err(error) => log_bridge(&format!("Named-pipe client failed: {error}")),
                }
            });
        }
    }

    async fn serve_connection<R, W>(
        &self,
        mut reader: R,
        mut writer: W,
        connection_id: u64,
        mut active_connection: watch::Receiver<u64>,
    ) -> Result<(), BridgeError>
    where
        R: AsyncRead + Unpin,
        W: AsyncWrite + Unpin,
    {
        let mut events = self.subscribe();
        let mut authenticated = false;
        let mut generation = 0;
        let (responses, mut pending_responses) = mpsc::unbounded_channel();

        loop {
            tokio::select! {
                changed = active_connection.changed() => {
                    if changed.is_err() || *active_connection.borrow() != connection_id {
                        log_bridge(&format!("Named-pipe client superseded id={connection_id}"));
                        break;
                    }
                }
                frame = read_frame(&mut reader) => {
                    let frame = match frame {
                        Ok(frame) => frame,
                        Err(BridgeError::Io(error)) if error.kind() == io::ErrorKind::UnexpectedEof => break,
                        Err(error) => {
                            if authenticated {
                                self.native.reset_routes();
                            }
                            return Err(error);
                        }
                    };
                    let request: BridgeRequest = from_slice(&frame)
                        .map_err(|error| {
                            if authenticated {
                                self.native.reset_routes();
                            }
                            BridgeError::Serialization(error.to_string())
                        })?;
                    if !authenticated && request.token == *self.token {
                        generation = request.generation;
                    }
                    let authorized = request.token == *self.token && request.generation == generation;
                    log_bridge(&format!(
                        "Bridge request received method={} authenticated={} request_generation={} expected_generation={generation}",
                        request.method,
                        authenticated,
                        request.generation,
                    ));
                    if !authorized {
                        log_bridge(&format!(
                            "Rejected bridge request method={} authenticated={} token_matches={} request_generation={} expected_generation={generation}",
                            request.method,
                            authenticated,
                            request.token == *self.token,
                            request.generation,
                        ));
                    }
                    if !authorized {
                        let response = self.dispatch(request, generation).await;
                        if let Err(error) = write_frame(&mut writer, &response).await {
                            log_bridge(&format!("Bridge response write failed: {error}"));
                            if authenticated {
                                self.native.reset_routes();
                            }
                            return Err(error);
                        }
                        break;
                    }
                    if authorized && !authenticated {
                        authenticated = true;
                        self.native.replay(self).await;
                    }
                    let bridge = self.clone();
                    let responses = responses.clone();
                    tokio::spawn(async move {
                        let method = request.method.clone();
                        let response = bridge.dispatch(request, generation).await;
                        log_bridge(&format!("Bridge request completed method={method}"));
                        let _ = responses.send(response);
                    });
                }
                response = pending_responses.recv(), if authenticated => {
                    let Some(response) = response else {
                        break;
                    };
                    if let Err(error) = write_frame(&mut writer, &response).await {
                        log_bridge(&format!("Bridge response write failed: {error}"));
                        self.native.reset_routes();
                        return Err(error);
                    }
                }
                event = events.recv(), if authenticated => {
                    match event {
                        Ok(mut event) => {
                            event.generation = generation;
                            if let Err(error) = write_frame(&mut writer, &event).await {
                                log_bridge(&format!(
                                    "Bridge event write failed topic={}: {error}",
                                    event.topic
                                ));
                                self.native.reset_routes();
                                return Err(error);
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
            }
        }

        if authenticated {
            self.native.reset_routes();
        }
        Ok(())
    }

    async fn dispatch(&self, request: BridgeRequest, generation: u64) -> BridgeResponse {
        if request.token != *self.token {
            return BridgeResponse {
                r#type: "response".to_string(),
                id: request.id,
                generation: request.generation,
                result: None,
                error: Some(BridgeErrorPayload {
                    code: "unauthorized".to_string(),
                    message: "Invalid host token".to_string(),
                }),
            };
        }
        if request.generation != generation {
            return BridgeResponse {
                r#type: "response".to_string(),
                id: request.id,
                generation,
                result: None,
                error: Some(BridgeErrorPayload {
                    code: "stale_generation".to_string(),
                    message: "Host bridge connection generation is stale".to_string(),
                }),
            };
        }

        match self
            .native
            .dispatch(self, &request.method, request.params)
            .await
        {
            Ok(result) => BridgeResponse {
                r#type: "response".to_string(),
                id: request.id,
                generation,
                result: Some(result),
                error: None,
            },
            Err(error) => BridgeResponse {
                r#type: "response".to_string(),
                id: request.id,
                generation,
                result: None,
                error: Some(BridgeErrorPayload {
                    code: "native_error".to_string(),
                    message: error,
                }),
            },
        }
    }
}

fn log_bridge(message: &str) {
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

#[cfg(windows)]
fn create_user_pipe(
    pipe_name: &str,
) -> io::Result<tokio::net::windows::named_pipe::NamedPipeServer> {
    use tokio::net::windows::named_pipe::ServerOptions;
    use windows::core::w;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
    use windows::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};

    // The owner-only DACL keeps the bridge private to the interactive user that
    // launched the connector. Tokio also asks the kernel to reject remote pipe
    // clients, and the per-process token remains the protocol-level guard.
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            w!("D:P(A;;GA;;;OW)"),
            1,
            &mut descriptor,
            None,
        )
        .map_err(|error| io::Error::other(format!("unable to create pipe ACL: {error}")))?;
    }
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: false.into(),
    };
    let result = unsafe {
        ServerOptions::new().create_with_security_attributes_raw(
            pipe_name,
            (&mut attributes as *mut SECURITY_ATTRIBUTES).cast(),
        )
    };
    unsafe {
        let _ = LocalFree(Some(HLOCAL(descriptor.0)));
    }
    result
}

async fn read_frame<R: AsyncRead + Unpin>(reader: &mut R) -> Result<Vec<u8>, BridgeError> {
    let length = reader.read_u32_le().await? as usize;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err(BridgeError::InvalidFrame(format!(
            "invalid frame length {length}"
        )));
    }
    let mut payload = vec![0u8; length];
    reader.read_exact(&mut payload).await?;
    Ok(payload)
}

async fn write_frame<W: AsyncWrite + Unpin, T: Serialize>(
    writer: &mut W,
    value: &T,
) -> Result<(), BridgeError> {
    let payload =
        to_vec_named(value).map_err(|error| BridgeError::Serialization(error.to_string()))?;
    if payload.is_empty() || payload.len() > MAX_FRAME_BYTES {
        return Err(BridgeError::InvalidFrame(format!(
            "invalid frame length {}",
            payload.len()
        )));
    }
    writer.write_u32_le(payload.len() as u32).await?;
    writer.write_all(&payload).await?;
    writer.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[tokio::test]
    async fn rejects_frames_larger_than_the_bridge_limit() {
        let mut reader = Cursor::new((MAX_FRAME_BYTES as u32 + 1).to_le_bytes());
        let error = read_frame(&mut reader)
            .await
            .expect_err("oversized frame accepted");
        assert!(
            matches!(error, BridgeError::InvalidFrame(message) if message.contains("invalid frame length"))
        );
    }

    #[tokio::test]
    async fn authenticates_tokens_and_connection_generations() {
        let bridge = BridgeServer::new("secret".to_string());
        let unauthorized = bridge
            .dispatch(
                BridgeRequest {
                    r#type: "request".to_string(),
                    id: 1,
                    token: "wrong".to_string(),
                    generation: 3,
                    method: "ping".to_string(),
                    params: Value::Null,
                },
                3,
            )
            .await;
        assert_eq!(
            unauthorized.error.as_ref().map(|error| error.code.as_str()),
            Some("unauthorized")
        );

        let stale = bridge
            .dispatch(
                BridgeRequest {
                    r#type: "request".to_string(),
                    id: 2,
                    token: "secret".to_string(),
                    generation: 2,
                    method: "ping".to_string(),
                    params: Value::Null,
                },
                3,
            )
            .await;
        assert_eq!(
            stale.error.as_ref().map(|error| error.code.as_str()),
            Some("stale_generation")
        );
    }

    #[test]
    fn request_serialization_matches_the_typescript_golden_frame() {
        let request = BridgeRequest {
            r#type: "request".to_string(),
            id: 1,
            token: "secret".to_string(),
            generation: 1,
            method: "ping".to_string(),
            params: Value::Object(Default::default()),
        };
        let payload = to_vec_named(&request).expect("request serialization failed");
        let encoded = payload
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        assert_eq!(
            encoded,
            "86a474797065a772657175657374a2696401a5746f6b656ea6736563726574aa67656e65726174696f6e01a66d6574686f64a470696e67a6706172616d7380"
        );
    }
}
