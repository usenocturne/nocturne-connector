use crate::bridge::BridgeServer;
use serde_json::Value;
use std::sync::Arc;

#[cfg(windows)]
mod windows;

#[derive(Clone)]
pub struct NativeServices {
    #[cfg(windows)]
    inner: Arc<windows::WindowsNativeState>,
}

impl NativeServices {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            #[cfg(windows)]
            inner: Arc::new(windows::WindowsNativeState::new()),
        })
    }

    pub async fn start(&self, bridge: BridgeServer) {
        #[cfg(windows)]
        self.inner.start(bridge).await;
        #[cfg(not(windows))]
        let _ = bridge;
    }

    pub fn reset_routes(&self) {
        #[cfg(windows)]
        self.inner.reset_routes();
    }

    pub async fn replay(&self, bridge: &BridgeServer) {
        #[cfg(windows)]
        self.inner.replay(bridge).await;
        #[cfg(not(windows))]
        let _ = bridge;
    }

    pub async fn dispatch(
        &self,
        bridge: &BridgeServer,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        #[cfg(windows)]
        {
            return self.inner.dispatch(bridge, method, params).await;
        }
        #[cfg(not(windows))]
        {
            let _ = (bridge, params);
            Err(format!(
                "Windows native host method is unavailable on macOS: {method}"
            ))
        }
    }
}
