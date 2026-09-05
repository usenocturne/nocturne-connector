import React, { useEffect, useState, useCallback, useRef } from "react";
import { get, post } from "../api";
import { useAutoRefresh, useEvent } from "../hooks/useWebSocket";
import { BluetoothDeviceList } from "../components/BluetoothDeviceList";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Search, Bluetooth as BluetoothIcon } from "lucide-react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { useConnectorPlatform } from "../hooks/useConnectorPlatform";

const BT_EVENTS = [
  "bluetooth.deviceConnected",
  "bluetooth.deviceDisconnected",
  "bluetooth.devicePaired",
  "bluetooth.deviceFound",
  "bluetooth.deviceUpdated",
];
const WINDOWS_BT_EVENTS = [...BT_EVENTS, "bluetooth.adapterStatus"];
const WINDOWS_SCAN_DURATION_MS = 30_000;
const SCAN_REFRESH_MS = 2_000;

interface PairingPinEvent {
  address: string;
  name: string;
  pin: string;
  type: "bluetooth_pin";
  confirmationRequired?: boolean;
  requestId?: string;
}

export function BluetoothPairing() {
  const { isWindows } = useConnectorPlatform();
  const [status, setStatus] = useState<any>(null);
  const [devices, setDevices] = useState<any[]>([]);
  const [connections, setConnections] = useState<any[]>([]);
  const [scanning, setScanning] = useState(false);
  const [pinEvent, setPinEvent] = useState<PairingPinEvent | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [submittingDecision, setSubmittingDecision] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [pairingAddress, setPairingAddress] = useState<string | null>(null);
  const [unpairingAddress, setUnpairingAddress] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const windowsScanGenerationRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    try { setStatus(await get("/api/bluetooth/status")); } catch {}
    try { setDevices((await get("/api/bluetooth/devices")).devices ?? []); } catch {}
    try { setConnections((await get("/api/bluetooth/connections")).connections ?? []); } catch {}
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useAutoRefresh(isWindows ? WINDOWS_BT_EVENTS : BT_EVENTS, refresh);

  useEvent<PairingPinEvent>("bluetooth.agent", useCallback((data) => {
    if (data.type === "bluetooth_pin") {
      setDecisionError(null);
      setPinEvent(data);
    }
  }, []));

  useEvent<{ error?: string }>("bluetooth.pairingCancelled", useCallback((event) => {
    setPinEvent(null);
    setPairingAddress(null);
    if (typeof event?.error === "string" && event.error.length > 0) {
      setPairError(event.error);
    }
  }, []));

  useEvent("bluetooth.devicePaired", useCallback(() => {
    setPinEvent(null);
    setPairingAddress(null);
    setPairError(null);
  }, []));

  useEffect(() => {
    if (!isWindows) return;
    let active = true;
    get("/api/bluetooth/pairing-request").then((result) => {
      if (active && result.pending) setPinEvent((current) => current ?? result.request);
    }).catch((error) => {
      if (active) setPairError(`Unable to restore pairing request: ${error instanceof Error ? error.message : String(error)}`);
    });
    return () => { active = false; };
  }, [isWindows]);

  const submitDecision = async (accepted: boolean) => {
    if (!pinEvent || submittingDecision) return;
    if (accepted && pinEvent.confirmationRequired === false) { setPinEvent(null); return; }
    const requestId = pinEvent.requestId;
    setSubmittingDecision(true);
    setDecisionError(null);
    try {
      await post(`/api/bluetooth/pairing-${accepted ? "confirm" : "reject"}`, isWindows ? {
        requestId,
      } : undefined);
      setPinEvent((current) => current?.requestId === requestId ? null : current);
      await refresh();
    } catch (error) {
      setDecisionError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmittingDecision(false);
    }
  };

  const startScan = async () => {
    setScanning(true);
    if (!isWindows) {
      try {
        await post("/api/bluetooth/scan");
        for (let i = 0; i < 30; i++) {
          if (!mountedRef.current) break;
          await new Promise((resolve) => setTimeout(resolve, SCAN_REFRESH_MS));
          if (!mountedRef.current) break;
          try {
            setDevices((await get("/api/bluetooth/devices")).devices ?? []);
          } catch {}
        }
        await post("/api/bluetooth/stop-scan");
        if (mountedRef.current) await refresh();
      } catch {}
      if (mountedRef.current) setScanning(false);
      return;
    }

    const scanGeneration = ++windowsScanGenerationRef.current;
    try {
      await post("/api/bluetooth/scan");
      const refreshCount = Math.ceil(
        WINDOWS_SCAN_DURATION_MS / SCAN_REFRESH_MS,
      );
      for (let i = 0; i < refreshCount; i++) {
        if (
          !mountedRef.current ||
          scanGeneration !== windowsScanGenerationRef.current
        ) break;
        await new Promise((r) => setTimeout(r, SCAN_REFRESH_MS));
        if (
          !mountedRef.current ||
          scanGeneration !== windowsScanGenerationRef.current
        ) break;
        try {
          setDevices((await get("/api/bluetooth/devices")).devices ?? []);
        } catch {}
      }
    } catch (error) {
      console.error("Bluetooth scan failed:", error);
    } finally {
      if (scanGeneration === windowsScanGenerationRef.current) {
        try {
          await post("/api/bluetooth/stop-scan");
        } catch (error) {
          console.error("Unable to stop Bluetooth scan:", error);
        }
        if (mountedRef.current) await refresh();
        if (mountedRef.current) setScanning(false);
      }
    }
  };

  const pairDevice = async (address: string) => {
    if (isWindows && (pairingAddress || unpairingAddress)) return;
    setPairError(null);
    if (isWindows) setPairingAddress(address);
    if (isWindows) {
      windowsScanGenerationRef.current++;
      setScanning(false);
      await post("/api/bluetooth/stop-scan").catch(() => undefined);
    }
    try {
      await post(`/api/bluetooth/pair/${address}`);
      await post(`/api/bluetooth/trust/${address}`).catch(() => undefined);
      await refresh();
    } catch (error) {
      if (isWindows) setPairingAddress(null);
      setPairError(error instanceof Error ? error.message : String(error));
    }
  };

  const unpairDevice = async (address: string) => {
    if (unpairingAddress) return;
    setPairError(null);
    setUnpairingAddress(address);
    try {
      await post(`/api/bluetooth/unpair/${address}`);
      setDevices((current) =>
        current.filter((device) =>
          typeof device?.address !== "string" ||
          device.address.toUpperCase() !== address.toUpperCase()
        )
      );
      setConnections((current) =>
        current.filter((connection) =>
          typeof connection?.address !== "string" ||
          connection.address.toUpperCase() !== address.toUpperCase()
        )
      );
      await refresh();
    } catch (error) {
      setPairError(error instanceof Error ? error.message : String(error));
      await refresh();
    } finally {
      setUnpairingAddress(null);
    }
  };

  return (
    <div>
      <div className="mb-10">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-3xl font-semibold tracking-tight text-fg">
              Bluetooth
            </h2>
            <p className="mt-2 text-secondary">
              Pair and manage your Car Thing connection.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={startScan}
            disabled={scanning || !status?.powered}
            className="mt-1"
          >
            <Search className="size-3.5" />
            {scanning ? "Scanning..." : "Scan for Devices"}
          </Button>
        </div>
      </div>

      {pairError && (
        <Alert variant="destructive" className="mb-6">
          <AlertDescription>{pairError}</AlertDescription>
        </Alert>
      )}

      {connections.length > 0 && (
        <div className="mb-8">
          <h3 className="mb-3 text-xs font-medium uppercase tracking-widest text-muted">
            Active Connections
          </h3>
          <div className="space-y-2">
            {connections.map((conn: any) => (
              <Card key={conn.devicePath} className="border-success/20 bg-success/5">
                <CardContent>
                  <div className="flex items-center gap-3">
                    <div className="flex size-9 items-center justify-center rounded-lg bg-success/10">
                      <BluetoothIcon className="size-4 text-success" />
                    </div>
                    <span className="font-medium text-fg">
                      {conn.name || (isWindows ? "Unknown Device" : "Device")}
                    </span>
                    <Badge variant="success" className="ml-auto">Connected</Badge>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      <div>
        <h3 className="mb-3 text-xs font-medium uppercase tracking-widest text-muted">
          Available Devices
        </h3>
        <BluetoothDeviceList
          devices={devices}
          onPair={isWindows
            ? pairDevice
            : async (addr) => {
                await post(`/api/bluetooth/pair/${addr}`);
                await post(`/api/bluetooth/trust/${addr}`).catch(() => undefined);
                refresh();
              }}
          onUnpair={isWindows
            ? unpairDevice
            : async (addr) => {
                await post(`/api/bluetooth/unpair/${addr}`);
                refresh();
              }}
          onConnect={async (addr) => { await post(`/api/bluetooth/connect/${addr}`); refresh(); }}
          onDisconnect={isWindows
            ? async (addr) => {
                await post(`/api/bluetooth/disconnect/${addr}`);
                refresh();
              }
            : undefined}
          busyAddress={isWindows ? unpairingAddress ?? pairingAddress : undefined}
          busyAction={unpairingAddress ? "unpair" : "pair"}
        />
      </div>

      <AlertDialog open={!!pinEvent}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pinEvent?.confirmationRequired === false
                ? "Bluetooth Pairing PIN"
                : "Bluetooth Pairing Request"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pinEvent?.confirmationRequired === false
                ? "Enter this PIN on "
                : "Confirm that this PIN matches the one shown on "}
              <span className="font-medium text-fg">
                {pinEvent?.name || pinEvent?.address}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex justify-center py-4">
            <span className="font-mono text-3xl font-bold tracking-[0.3em] text-fg sm:text-4xl">
              {pinEvent?.pin ?? ""}
            </span>
          </div>
          {decisionError && <p role="alert" className="text-red-500">{decisionError}</p>}
          <AlertDialogFooter>
            {pinEvent?.confirmationRequired !== false && (
              <AlertDialogCancel disabled={submittingDecision} onClick={(event) => { event.preventDefault(); void submitDecision(false); }}>Reject</AlertDialogCancel>
            )}
            <AlertDialogAction disabled={submittingDecision} onClick={(event) => { event.preventDefault(); void submitDecision(true); }}>
              {pinEvent?.confirmationRequired === false ? "Done" : "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
