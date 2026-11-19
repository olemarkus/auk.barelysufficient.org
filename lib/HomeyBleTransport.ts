import type HomeySDK from 'homey';
import type { AukTransport } from './AukController';
import type { AukLink } from './AukSession';
import { NOTIFY_CHARACTERISTIC, WRITE_CHARACTERISTIC } from './protocol';

type BlePeripheral = Awaited<ReturnType<Awaited<ReturnType<HomeySDK.Device['homey']['ble']['find']>>['connect']>>;
type BleCharacteristic = BlePeripheral['services'][number]['characteristics'][number];

const normalizeUuid = (uuid: string): string => uuid.replace(/-/g, '').toLowerCase();

const findCharacteristic = (peripheral: BlePeripheral, uuid: string): BleCharacteristic => {
  for (const service of peripheral.services) {
    const match = service.characteristics.find((c) => normalizeUuid(c.uuid) === uuid);
    if (match) return match;
  }
  throw new Error(`Characteristic ${uuid} not found`);
};

/** Opens Auk links through Homey's BLE manager. */
export class HomeyBleTransport implements AukTransport {
  constructor(
    private readonly homey: HomeySDK.Device['homey'],
    private readonly peripheralUuid: string,
  ) {}

  async open(handlers: { onData: (data: Buffer) => void; onClose: () => void }): Promise<AukLink> {
    const advertisement = await this.homey.ble.find(this.peripheralUuid);
    const peripheral = await advertisement.connect();
    let closed = false;
    const onDisconnect = () => {
      if (closed) return;
      closed = true;
      handlers.onClose();
    };
    peripheral.once('disconnect', onDisconnect);
    try {
      await peripheral.discoverAllServicesAndCharacteristics();
      const writer = findCharacteristic(peripheral, WRITE_CHARACTERISTIC);
      const notifier = findCharacteristic(peripheral, NOTIFY_CHARACTERISTIC);
      await notifier.subscribeToNotifications((data: Buffer) => handlers.onData(data));
      return {
        write: async (data) => { await writer.write(data); },
        close: async () => {
          closed = true;
          peripheral.removeListener('disconnect', onDisconnect);
          await peripheral.disconnect();
        },
      };
    } catch (error) {
      closed = true;
      peripheral.removeListener('disconnect', onDisconnect);
      await peripheral.disconnect().catch(() => undefined);
      throw error;
    }
  }
}
