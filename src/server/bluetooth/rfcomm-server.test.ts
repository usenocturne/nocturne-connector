import { afterEach, describe, expect, test } from "bun:test";
import { fstatSync, mkdtempSync, openSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RFCOMMServer } from "./rfcomm-server";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function inode(fd: number): number | null {
  try {
    return fstatSync(fd).ino;
  } catch {
    return null;
  }
}

function stillRefersTo(fd: number, ino: number | null): boolean {
  return ino !== null && inode(fd) === ino;
}

function openFixture(contents: string): number {
  const dir = mkdtempSync(join(tmpdir(), "rfcomm-server-"));
  dirs.push(dir);
  const path = join(dir, "socket");
  writeFileSync(path, contents);
  return openSync(path, "r");
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i++) await Bun.sleep(5);
}

describe("RFCOMMServer connection fds", () => {
  test("closes the BlueZ fd when the peer stream ends", async () => {
    const server = new RFCOMMServer();
    const disconnected: string[] = [];
    server.setDisconnectionHandler((device) => disconnected.push(device));
    const fd = openFixture("hello\n");
    const ino = inode(fd);

    server.handleNewConnection("/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF", fd);
    await waitFor(() => disconnected.length > 0);

    expect(disconnected).toEqual(["/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF"]);
    expect(stillRefersTo(fd, ino)).toBeFalse();
  });

  test("closes the BlueZ fd when BlueZ requests disconnection", () => {
    const server = new RFCOMMServer();
    const fd = openFixture("");
    const ino = inode(fd);
    const device = "/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF";

    server.handleNewConnection(device, fd);
    server.handleRequestDisconnection(device);

    expect(stillRefersTo(fd, ino)).toBeFalse();
    expect(server.getConnections().has(device)).toBeFalse();
  });

  test("closes a replaced connection's fd and keeps the new one", () => {
    const server = new RFCOMMServer();
    const device = "/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF";
    const first = openFixture("");
    const firstIno = inode(first);
    const second = openFixture("");

    server.handleNewConnection(device, first);
    server.handleNewConnection(device, second);

    expect(stillRefersTo(first, firstIno)).toBeFalse();
    expect(server.getConnections().get(device)?.fd).toBe(second);
    server.handleRequestDisconnection(device);
  });
});
