use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::Duration;

use crate::bridge::BridgeServer;

pub struct ManagedChild {
    child: Child,
    #[cfg(windows)]
    job: JobObject,
}

pub type ChildSlot = Arc<Mutex<Option<ManagedChild>>>;

pub fn supervise(
    bridge: BridgeServer,
    port: Arc<Mutex<Option<u16>>>,
    ready: Arc<AtomicBool>,
    shutting_down: Arc<AtomicBool>,
    child_slot: ChildSlot,
) {
    thread::spawn(move || {
        let mut restart_delay = Duration::from_secs(1);
        while !shutting_down.load(Ordering::Acquire) {
            ready.store(false, Ordering::Release);
            match spawn_once(&bridge, &port, &ready, &child_slot) {
                Ok(status) => {
                    eprintln!("Nocturne Connector server exited with {status}");
                    restart_delay = Duration::from_secs(1);
                }
                Err(error) => {
                    eprintln!("Nocturne Connector server failed to start: {error}");
                }
            }
            ready.store(false, Ordering::Release);
            bridge.reset_after_sidecar_exit();

            if shutting_down.load(Ordering::Acquire) {
                break;
            }
            thread::sleep(restart_delay);
            restart_delay = (restart_delay * 2).min(Duration::from_secs(30));
        }
    });
}

pub fn stop(shutting_down: &AtomicBool, child_slot: &ChildSlot) {
    shutting_down.store(true, Ordering::Release);
    if let Ok(mut child) = child_slot.lock() {
        if let Some(process) = child.as_mut() {
            #[cfg(windows)]
            process.job.terminate();
            let _ = process.child.kill();
        }
        *child = None;
    }
}

fn spawn_once(
    _bridge: &BridgeServer,
    port: &Arc<Mutex<Option<u16>>>,
    ready: &Arc<AtomicBool>,
    child_slot: &ChildSlot,
) -> Result<i32, String> {
    let requested_port = port.lock().ok().and_then(|current_port| *current_port);
    let executable = server_executable();
    let mut command = if executable.exists() {
        Command::new(executable)
    } else if let Ok(fallback) = std::env::var("NOCTURNE_SERVER_COMMAND") {
        Command::new(fallback)
    } else {
        return Err(format!(
            "server executable does not exist: {}",
            executable.display()
        ));
    };

    let client_dist = client_dist_directory();
    command
        .env("NOCTURNE_CONNECTOR_BIND_HOST", "127.0.0.1")
        .env(
            "PORT",
            requested_port
                .map(|value| value.to_string())
                .unwrap_or_else(|| "0".to_string()),
        )
        .env("NOCTURNE_CONNECTOR_VERSION", env!("CARGO_PKG_VERSION"))
        .env("NOCTURNE_CLIENT_DIST_DIR", client_dist)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    let mut child = command.spawn().map_err(|error| error.to_string())?;
    #[cfg(windows)]
    let job = match JobObject::new(&child) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            return Err(error);
        }
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    if let Some(stdout) = stdout {
        let port = Arc::clone(port);
        let ready = Arc::clone(ready);
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Some(value) = line.strip_prefix("NOCTURNE_READY_PORT=") {
                    if let Ok(value) = value.trim().parse::<u16>() {
                        if let Ok(mut target) = port.lock() {
                            *target = Some(value);
                            ready.store(true, Ordering::Release);
                        }
                    }
                }
                eprintln!("[connector] {line}");
            }
        });
    }
    if let Some(stderr) = stderr {
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                eprintln!("[connector] {line}");
            }
        });
    }

    {
        let mut slot = child_slot
            .lock()
            .map_err(|_| "child slot is poisoned".to_string())?;
        *slot = Some(ManagedChild {
            child,
            #[cfg(windows)]
            job,
        });
    }
    let status = loop {
        let result = {
            let mut slot = child_slot
                .lock()
                .map_err(|_| "child slot is poisoned".to_string())?;
            let Some(process) = slot.as_mut() else {
                return Err("server child disappeared".to_string());
            };
            process
                .child
                .try_wait()
                .map_err(|error| error.to_string())?
        };
        if let Some(status) = result {
            break status;
        }
        thread::sleep(Duration::from_millis(100));
    };
    if let Ok(mut slot) = child_slot.lock() {
        *slot = None;
    }
    if status.success() {
        Ok(status.code().unwrap_or(0))
    } else {
        Err(format!("exit status {status}"))
    }
}

fn server_executable() -> PathBuf {
    if let Ok(path) = std::env::var("NOCTURNE_SERVER_EXECUTABLE") {
        return PathBuf::from(path);
    }
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."))
        .join(if cfg!(windows) {
            "nocturne-connector-server.exe"
        } else {
            "nocturne-connector-server"
        })
}

fn client_dist_directory() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("client")
}

#[cfg(windows)]
struct JobObject(usize);

#[cfg(windows)]
impl JobObject {
    fn new(child: &Child) -> Result<Self, String> {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        let job = unsafe { CreateJobObjectW(None, None) }
            .map_err(|error| format!("Unable to create server job object: {error}"))?;
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if let Err(error) = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } {
            unsafe {
                let _ = windows::Win32::Foundation::CloseHandle(job);
            }
            return Err(format!("Unable to configure server job object: {error}"));
        }
        let process = windows::Win32::Foundation::HANDLE(child.as_raw_handle() as _);
        if let Err(error) = unsafe { AssignProcessToJobObject(job, process) } {
            unsafe {
                let _ = windows::Win32::Foundation::CloseHandle(job);
            }
            return Err(format!("Unable to assign server to job object: {error}"));
        }
        Ok(Self(job.0 as usize))
    }

    fn terminate(&self) {
        use windows::Win32::System::JobObjects::TerminateJobObject;
        unsafe {
            let _ = TerminateJobObject(
                windows::Win32::Foundation::HANDLE(self.0 as *mut std::ffi::c_void),
                1,
            );
        }
    }
}

#[cfg(windows)]
impl Drop for JobObject {
    fn drop(&mut self) {
        use windows::Win32::Foundation::CloseHandle;
        unsafe {
            let _ = CloseHandle(windows::Win32::Foundation::HANDLE(
                self.0 as *mut std::ffi::c_void,
            ));
        }
    }
}
