export interface BluetoothDevice {
  address: string;
  name: string;
  paired: boolean;
  connected: boolean;
  trusted: boolean;
  rssi: number;
  icon: string;
}
