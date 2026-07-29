export const MAX_OTA_TRANSFER_WINDOW_BYTES = 128 * 1024;

export function requireOtaTransferWindow(size: number): number {
  if (
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > MAX_OTA_TRANSFER_WINDOW_BYTES
  ) {
    throw new Error(`Invalid OTA transfer size ${size}`);
  }
  return size;
}
