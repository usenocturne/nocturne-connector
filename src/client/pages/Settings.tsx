import React, { useCallback, useEffect, useState } from "react";
import { get, post } from "../api";
import { useEvent } from "../hooks/useWebSocket";
import { useAuth } from "../hooks/useAuth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { LogOut, Trash2, RotateCw, ExternalLink, RefreshCw, Download } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

type OtaStage =
  | "idle"
  | "checking"
  | "downloading"
  | "verifying"
  | "flashing"
  | "ready"
  | "failed";

interface ConnectorOtaStatus {
  inProgress: boolean;
  stage: OtaStage;
  currentVersion: string;
  targetVersion: string | null;
  activeSlot: "A" | "B" | "unknown";
  inactiveSlot: "A" | "B" | "unknown";
  supported: boolean;
  rebootRequired: boolean;
  updateAvailable: boolean | null;
  availableVersion: string | null;
  bytesComplete: number | null;
  bytesTotal: number | null;
  percent: number | null;
  speedBytesPerSecond: number | null;
  error: string | null;
}

interface ConnectorOtaCheck {
  updateAvailable: boolean;
  currentVersion: string;
  version: string | null;
  channel: string;
  size: number | null;
  message?: string;
}

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "Unknown";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  try {
    const parsed = JSON.parse(raw);
    return parsed.error ?? raw;
  } catch {
    return raw;
  }
}

function stageLabel(stage: OtaStage): string {
  switch (stage) {
    case "downloading":
      return "Downloading";
    case "verifying":
      return "Verifying";
    case "flashing":
      return "Flashing";
    case "ready":
      return "Ready to reboot";
    case "failed":
      return "Failed";
    case "checking":
      return "Checking";
    default:
      return "Idle";
  }
}

export function Settings() {
  const { user, signOut, refresh } = useAuth();
  const [info, setInfo] = useState<any>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [analyticsEnabled, setAnalyticsEnabled] = useState<boolean | null>(null);
  const [analyticsBusy, setAnalyticsBusy] = useState(false);
  const [otaStatus, setOtaStatus] = useState<ConnectorOtaStatus | null>(null);
  const [otaCheck, setOtaCheck] = useState<ConnectorOtaCheck | null>(null);
  const [otaBusy, setOtaBusy] = useState<"check" | "start" | null>(null);
  const [otaError, setOtaError] = useState<string | null>(null);

  useEffect(() => {
    get("/api/info").then(setInfo).catch(() => { });
  }, []);

  useEffect(() => {
    get<{ enabled: boolean }>("/api/analytics/status")
      .then((r) => setAnalyticsEnabled(r.enabled))
      .catch(() => { });
  }, []);

  useEffect(() => {
    get<ConnectorOtaStatus>("/api/ota/connector/status")
      .then(setOtaStatus)
      .catch(() => { });
  }, []);

  useEvent(
    "connector.ota.status",
    useCallback((status: ConnectorOtaStatus) => {
      setOtaStatus(status);
      if (status.error) setOtaError(status.error);
    }, [])
  );

  const handleDelete = async (e: React.MouseEvent) => {
    e.preventDefault();
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await post("/api/auth/delete-account");
      if (res.error) throw new Error(res.error);
      setDeleteOpen(false);
      await refresh();
    } catch (err: any) {
      setDeleteError(err.message ?? "Unable to delete your account right now.");
    } finally {
      setDeleting(false);
    }
  };

  const handleAnalyticsToggle = async (checked: boolean) => {
    if (analyticsBusy) return;
    const prev = analyticsEnabled;
    setAnalyticsEnabled(checked);
    setAnalyticsBusy(true);
    try {
      const res = await post<{ enabled: boolean }>("/api/analytics/enabled", {
        enabled: checked,
      });
      setAnalyticsEnabled(res.enabled);
    } catch {
      if (prev !== null) setAnalyticsEnabled(prev);
    } finally {
      setAnalyticsBusy(false);
    }
  };

  const handleOtaCheck = async () => {
    if (otaBusy || otaStatus?.inProgress) return;
    setOtaBusy("check");
    setOtaError(null);
    try {
      const result = await post<ConnectorOtaCheck>("/api/ota/connector/check", {
        channel: "stable",
      });
      setOtaCheck(result);
      const status = await get<ConnectorOtaStatus>("/api/ota/connector/status");
      setOtaStatus(status);
    } catch (err) {
      setOtaError(errorMessage(err));
    } finally {
      setOtaBusy(null);
    }
  };

  const handleOtaStart = async () => {
    if (otaBusy || otaStatus?.inProgress || !otaCheck?.version) return;
    setOtaBusy("start");
    setOtaError(null);
    try {
      const status = await post<ConnectorOtaStatus>("/api/ota/connector/start", {
        channel: otaCheck.channel,
        targetVersion: otaCheck.version,
      });
      setOtaStatus(status);
    } catch (err) {
      setOtaError(errorMessage(err));
    } finally {
      setOtaBusy(null);
    }
  };

  const progressValue = otaStatus?.percent ?? 0;
  const showProgress =
    otaStatus?.inProgress &&
    ["downloading", "verifying", "flashing"].includes(otaStatus.stage);
  const installableUpdate = Boolean(otaCheck?.updateAvailable && otaCheck.version);

  return (
    <div>
      <div className="mb-10">
        <h2 className="text-3xl font-semibold tracking-tight text-fg">
          Settings
        </h2>
        <p className="mt-2 text-secondary">
          Manage your account, view system info, and configure your connector.
        </p>
      </div>

      <div className="space-y-8">
        <section>
          <h3 className="mb-4 text-xs font-medium uppercase tracking-widest text-muted">
            Account
          </h3>
          <Card>
            <CardContent className="space-y-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-sm text-secondary">Signed in as</p>
                  <p className="mt-0.5 break-all text-lg font-medium text-fg">{user?.email}</p>
                </div>
                <Button variant="outline" size="sm" onClick={signOut} className="shrink-0">
                  <LogOut className="size-3.5" />
                  Sign Out
                </Button>
              </div>
              <div className="border-t border-line pt-4">
                <p className="text-sm text-secondary">
                  Manage your password and account at{" "}
                  <a
                    href="https://usenocturne.com/login"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-accent transition hover:text-accent-hover"
                  >
                    usenocturne.com
                    <ExternalLink className="size-3" />
                  </a>
                </p>
              </div>
            </CardContent>
          </Card>
        </section>

        <section>
          <h3 className="mb-4 text-xs font-medium uppercase tracking-widest text-muted">
            System
          </h3>
          <Card>
            <CardContent>
              <div className="space-y-3">
                {[
                  ["Connector Version", info?.version ?? "Unknown"],
                  ["OS Version", info?.osVersion ?? "Unknown"],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between rounded-lg bg-bg px-3 py-2.5">
                    <span className="text-sm text-secondary">{label}</span>
                    <span className="text-sm font-medium text-fg">{value}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </section>

        <section>
          <h3 className="mb-4 text-xs font-medium uppercase tracking-widest text-muted">
            Updates
          </h3>
          <Card>
            <CardContent className="space-y-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium text-fg">Connector OS</p>
                    {otaStatus && (
                      <Badge
                        variant={otaStatus.stage === "failed" ? "destructive" : otaStatus.rebootRequired ? "success" : "secondary"}
                      >
                        {stageLabel(otaStatus.stage)}
                      </Badge>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleOtaCheck}
                    disabled={otaBusy !== null || otaStatus?.inProgress}
                  >
                    <RefreshCw className={otaBusy === "check" ? "size-3.5 animate-spin" : "size-3.5"} />
                    {otaBusy === "check" ? "Checking" : "Check"}
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleOtaStart}
                    disabled={!installableUpdate || otaBusy !== null || otaStatus?.inProgress || otaStatus?.rebootRequired}
                  >
                    <Download className="size-3.5" />
                    {otaBusy === "start" ? "Starting" : "Update"}
                  </Button>
                  {otaStatus?.rebootRequired && (
                    <Button size="sm" onClick={() => post("/api/power/reboot")}>
                      <RotateCw className="size-3.5" />
                      Reboot
                    </Button>
                  )}
                </div>
              </div>

              <div className="space-y-3">
                {[
                  ["Current Version", otaStatus?.currentVersion ?? info?.version ?? "Unknown"],
                  ["Available Version", otaCheck?.version ?? otaStatus?.availableVersion ?? "None"],
                  ["Package Size", formatBytes(otaCheck?.size)],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between rounded-lg bg-bg px-3 py-2.5">
                    <span className="text-sm text-secondary">{label}</span>
                    <span className="text-sm font-medium text-fg">{value}</span>
                  </div>
                ))}
              </div>

              {showProgress && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs text-secondary">
                    <span>{stageLabel(otaStatus.stage)}</span>
                    <span>{otaStatus.percent !== null ? `${otaStatus.percent}%` : formatBytes(otaStatus.bytesComplete)}</span>
                  </div>
                  <Progress value={progressValue} />
                </div>
              )}

              {otaCheck && !otaCheck.updateAvailable && (
                <p className="text-sm text-secondary">
                  {otaCheck.message ?? "Connector is up to date."}
                </p>
              )}

              {otaStatus?.rebootRequired && (
                <Alert>
                  <AlertDescription>Update staged. Reboot to finish.</AlertDescription>
                </Alert>
              )}

              {otaError && (
                <Alert variant="destructive">
                  <AlertDescription>{otaError}</AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        </section>

        <section>
          <h3 className="mb-4 text-xs font-medium uppercase tracking-widest text-muted">
            Privacy
          </h3>
          <Card>
            <CardContent>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="font-medium text-fg">Analytics</p>
                  <p className="mt-0.5 text-sm text-secondary">
                    Help improve Nocturne by sharing usage data.
                  </p>
                </div>
                <Switch
                  checked={analyticsEnabled ?? true}
                  onCheckedChange={handleAnalyticsToggle}
                  disabled={analyticsEnabled === null || analyticsBusy}
                  aria-label="Toggle analytics"
                  className="shrink-0"
                />
              </div>
            </CardContent>
          </Card>
        </section>

        <section>
          <h3 className="mb-4 text-xs font-medium uppercase tracking-widest text-destructive/60">
            Danger Zone
          </h3>
          <Card className="border-destructive/20">
            <CardContent className="space-y-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-medium text-fg">Reboot Device</p>
                  <p className="mt-0.5 text-sm text-secondary">
                    Temporarily disconnects all services while the device restarts.
                  </p>
                </div>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" size="sm" className="shrink-0">
                      <RotateCw className="size-3.5" />
                      Reboot
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Reboot Connector</AlertDialogTitle>
                      <AlertDialogDescription>
                        Are you sure you want to reboot the device? This will temporarily disconnect all services.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={() => post("/api/power/reboot")}>
                        Reboot
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>

              <div className="border-t border-line" />

              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-medium text-fg">Delete Account</p>
                  <p className="mt-0.5 text-sm text-secondary">
                    Permanently removes your account and all associated data.
                  </p>
                </div>
                <AlertDialog
                  open={deleteOpen}
                  onOpenChange={(open) => {
                    if (deleting) return;
                    setDeleteOpen(open);
                    if (!open) setDeleteError(null);
                  }}
                >
                  <AlertDialogTrigger asChild>
                    <Button variant="destructive" size="sm" className="shrink-0">
                      <Trash2 className="size-3.5" />
                      Delete Account
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete Account</AlertDialogTitle>
                      <AlertDialogDescription>
                        Deleting your account will remove all associated data. This action cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    {deleteError && (
                      <Alert variant="destructive">
                        <AlertDescription>{deleteError}</AlertDescription>
                      </Alert>
                    )}
                    <AlertDialogFooter>
                      <AlertDialogCancel disabled={deleting}>
                        Cancel
                      </AlertDialogCancel>
                      <AlertDialogAction
                        variant="destructive"
                        disabled={deleting}
                        onClick={handleDelete}
                      >
                        {deleting ? "Deleting..." : "Delete Account"}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </CardContent>
          </Card>
        </section>
      </div>
    </div>
  );
}
