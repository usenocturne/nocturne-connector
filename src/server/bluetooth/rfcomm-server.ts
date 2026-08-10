import { createLogger } from "../utils/logger";
import { RFCOMM_UUID } from "../config";
import { writeAllAsync } from "./async-fd-writer";

const log = createLogger("RFCOMMServer");

export interface RFCOMMConnection {
  devicePath: string;
  address: string;
  fd: number;
  stream: any;
}

export type ConnectionHandler = (conn: RFCOMMConnection) => void;
export type DisconnectionHandler = (devicePath: string) => void;
export type DataHandler = (devicePath: string, data: Buffer) => void;

interface ServerWriteState {
  connection: RFCOMMConnection;
  fd: number;
  tail: Promise<void>;
}

export class RFCOMMServer {
  private bus: any = null;
  private profilePath = "/com/usenocturne/rfcomm";
  private onConnection: ConnectionHandler | null = null;
  private onDisconnection: DisconnectionHandler | null = null;
  private onData: DataHandler | null = null;
  private connections = new Map<string, RFCOMMConnection>();
  private writeStates = new Map<string, ServerWriteState>();

  setConnectionHandler(handler: ConnectionHandler): void {
    this.onConnection = handler;
  }

  setDisconnectionHandler(handler: DisconnectionHandler): void {
    this.onDisconnection = handler;
  }

  setDataHandler(handler: DataHandler): void {
    this.onData = handler;
  }

  async register(): Promise<void> {
    try {
      const dbus = await import("dbus-next");
      this.bus = dbus.systemBus();

      const obj = await this.bus.getProxyObject("org.bluez", "/org/bluez");
      const profileManager = obj.getInterface("org.bluez.ProfileManager1");

      const options = {
        Name: new dbus.Variant("s", "Nocturne SPP"),
        Channel: new dbus.Variant("q", 1),
        AutoConnect: new dbus.Variant("b", true),
      };

      const DbusInterface = dbus.interface.Interface;
      const server = this;

      class Profile1 extends DbusInterface {
        NewConnection(device: string, fd: number, _fdProps: any) {
          log.info(`New RFCOMM connection from ${device}, fd=${fd}`);
          const address = device.split("/").pop()?.replace(/_/g, ":") ?? "";
          const conn: RFCOMMConnection = { devicePath: device, address, fd, stream: null };
          server.connections.set(device, conn);
          server.writeStates.set(device, {
            connection: conn,
            fd,
            tail: Promise.resolve(),
          });
          server.setupFdReading(conn);
          server.onConnection?.(conn);
        }

        RequestDisconnection(device: string) {
          log.info(`RFCOMM disconnection requested: ${device}`);
          server.connections.delete(device);
          server.writeStates.delete(device);
          server.onDisconnection?.(device);
        }

        Release() {
          log.info("Profile released");
        }
      }

      Profile1.configureMembers({
        methods: {
          NewConnection: { inSignature: "oha{sv}", outSignature: "" },
          RequestDisconnection: { inSignature: "o", outSignature: "" },
          Release: { inSignature: "", outSignature: "" },
        },
      });

      const profile = new Profile1("org.bluez.Profile1");
      this.bus.export(this.profilePath, profile);

      await profileManager.RegisterProfile(this.profilePath, RFCOMM_UUID, options);
      log.info("RFCOMM profile registered");
    } catch (err) {
      log.warn(`RFCOMM registration not available: ${err}`);
    }
  }

  private setupFdReading(connection: RFCOMMConnection): void {
    const { devicePath, fd } = connection;
    const readable = Bun.file(fd);
    const reader = readable.stream().getReader();

    const readLoop = async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            this.onData?.(devicePath, Buffer.from(value));
          }
        }
      } catch {}
      if (this.connections.get(devicePath) === connection) {
        this.connections.delete(devicePath);
        this.writeStates.delete(devicePath);
        this.onDisconnection?.(devicePath);
      }
    };

    readLoop();
  }

  writeToDevice(devicePath: string, data: Buffer): Promise<void> {
    const conn = this.connections.get(devicePath);
    const state = this.writeStates.get(devicePath);
    if (!conn || !state || state.connection !== conn) {
      throw new Error(`No connection for ${devicePath}`);
    }
    const buffer = Buffer.from(data);
    const isCurrent = () =>
      this.connections.get(devicePath) === conn &&
      this.writeStates.get(devicePath) === state &&
      conn.fd === state.fd;
    const write = state.tail
      .catch((error) => {
        log.warn(`Previous write to ${devicePath} failed: ${error}`);
      })
      .then(() => writeAllAsync(conn.fd, buffer, isCurrent))
      .catch((error) => {
        log.error(`Write to ${devicePath} failed: ${error}`);
        throw error;
      });
    state.tail = write;
    return write;
  }

  getConnections(): Map<string, RFCOMMConnection> {
    return this.connections;
  }

  async unregister(): Promise<void> {
    if (!this.bus) return;
    try {
      const obj = await this.bus.getProxyObject("org.bluez", "/org/bluez");
      const profileManager = obj.getInterface("org.bluez.ProfileManager1");
      await profileManager.UnregisterProfile(this.profilePath);
    } catch {}
  }
}
