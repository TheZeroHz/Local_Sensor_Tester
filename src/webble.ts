import { SensorData } from './sensor-types';

// GATT UUIDs must match firmware
const SERVICE_UUID = '9c2a8b2a-6c7a-4b8b-bf3c-7f6b1f7f0001';
const PACKET_UUID = '9c2a8b2a-6c7a-4b8b-bf3c-7f6b1f7f2001';
const CONTROL_UUID = '9c2a8b2a-6c7a-4b8b-bf3c-7f6b1f7f1001';

type WebBLEEvents = {
  connected: () => void;
  disconnected: () => void;
  data: (data: SensorData) => void;
  error: (error: Error) => void;
};

export class WebBLEManager {
  private device: BluetoothDevice | null = null;
  private server: BluetoothRemoteGATTServer | null = null;
  private packetChar: BluetoothRemoteGATTCharacteristic | null = null;
  private controlChar: BluetoothRemoteGATTCharacteristic | null = null;
  private eventListeners: { [K in keyof WebBLEEvents]?: WebBLEEvents[K][] } = {};

  // Keep latest values from notifications to emit combined packets
  private latestAccel: { x: number; y: number; z: number } | null = null;
  private latestGyro: { x: number; y: number; z: number } | null = null;
  private latestMag: { x: number; y: number; z: number } | null = null; // Added magnetometer
  private latestGyroInt: { roll: number; pitch: number; yaw: number } | null = null;
  private latestFusion: { roll: number; pitch: number; yaw: number } | null = null;
  private latestFusionMag: { roll: number; pitch: number; yaw: number } | null = null; // Added AHRS with mag
  private latestTemp: number | null = null;
  private emitScheduled = false;
  private latestTimeSec: number | null = null; // absolute device time

  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && typeof (navigator as unknown as Navigator).bluetooth !== 'undefined';
  }

  get isConnected(): boolean {
    return !!this.server && this.server.connected;
  }

  on<K extends keyof WebBLEEvents>(event: K, callback: WebBLEEvents[K]) {
    if (!this.eventListeners[event]) this.eventListeners[event] = [];
    this.eventListeners[event]!.push(callback);
  }

  private emit<K extends keyof WebBLEEvents>(event: K, ...args: Parameters<WebBLEEvents[K]>) {
    const listeners = this.eventListeners[event] as WebBLEEvents[K][] | undefined;
    if (!listeners) return;
    for (const cb of listeners) {
      (cb as (...cbArgs: Parameters<WebBLEEvents[K]>) => void)(...args);
    }
  }

  async connect() {
    try {
      if (!WebBLEManager.isSupported()) {
        throw new Error('Web Bluetooth is not supported. Use Chrome/Edge over HTTPS/localhost.');
      }
      if (this.isConnected) return;

      const device = await (navigator as unknown as Navigator).bluetooth.requestDevice({
        filters: [{ namePrefix: 'ESP32IMU' }],
        optionalServices: [SERVICE_UUID],
      });
      this.device = device;
      device.addEventListener('gattserverdisconnected', () => this.handleDisconnect());

      const server = await device.gatt!.connect();
      this.server = server;
      const service = await server.getPrimaryService(SERVICE_UUID);

      // Get only the combined packet characteristic
      this.packetChar = await service.getCharacteristic(PACKET_UUID);
      // Control characteristic (write only)
      try {
        this.controlChar = await service.getCharacteristic(CONTROL_UUID);
      } catch {
        this.controlChar = null; // tolerate firmware without control char
      }

      await this.startNotifications();
      this.emit('connected');
    } catch (err) {
      console.error('BLE connect error:', err);
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  async disconnect() {
    try {
      if (this.device && this.device.gatt && this.device.gatt.connected) {
        await this.device.gatt.disconnect();
      }
    } finally {
      this.handleDisconnect();
    }
  }

  private handleDisconnect() {
    this.server = null;
    this.packetChar = null;
    this.controlChar = null;
    this.latestAccel = null;
    this.latestGyro = null;
    this.latestMag = null;
    this.latestFusion = null;
    this.latestFusionMag = null;
    this.latestGyroInt = null;
    this.latestTemp = null;
    this.emitScheduled = false;
    this.emit('disconnected');
  }

  async sendCommand(command: string): Promise<void> {
    try {
      if (!this.controlChar) throw new Error('Control characteristic not available');
      const enc = new TextEncoder();
      const data = enc.encode(command + '\n');
      const anyChar = this.controlChar as unknown as { writeValueWithoutResponse?: (d: BufferSource) => Promise<void>; writeValue?: (d: BufferSource) => Promise<void> };
      if (anyChar.writeValueWithoutResponse) {
        await anyChar.writeValueWithoutResponse(data);
      } else if (anyChar.writeValue) {
        await anyChar.writeValue(data);
      } else {
        throw new Error('Control characteristic does not support write');
      }
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  private async startNotifications() {
    const tryStart = async (char: BluetoothRemoteGATTCharacteristic | null, onChange: (dv: DataView) => void) => {
      if (!char) return;
      try {
        await char.startNotifications();
        char.addEventListener('characteristicvaluechanged', (ev: Event) => {
          const target = (ev.target as unknown) as BluetoothRemoteGATTCharacteristic;
          const dv = target.value as DataView;
          onChange(dv);
        });
        console.log('startNotifications succeeded');
      } catch (e) {
        console.warn('startNotifications failed', e);
      }
    };

    // Combined packet notification - now expecting 20 float32 values (was 14)
    await tryStart(this.packetChar, (dv) => {
      // Updated packet layout: 20 float32 little-endian
      // accel(3) + gyro(3) + mag(3) + gyroInt(3) + fusion(3) + fusionMag(3) + temp(1) + time(1) = 20 values
      const values = new Float32Array(20);
      for (let i = 0; i < 20; i++) values[i] = dv.getFloat32(i * 4, true);
      
      this.latestAccel = { x: values[0], y: values[1], z: values[2] };
      this.latestGyro = { x: values[3], y: values[4], z: values[5] };
      this.latestMag = { x: values[6], y: values[7], z: values[8] };
      this.latestGyroInt = { roll: values[9], pitch: values[10], yaw: values[11] };
      this.latestFusion = { roll: values[12], pitch: values[13], yaw: values[14] };
      this.latestFusionMag = { roll: values[15], pitch: values[16], yaw: values[17] };
      this.latestTemp = values[18];
      this.latestTimeSec = isFinite(values[19]) ? values[19] : null;
      
      this.scheduleEmitIfReady();
    });
  }

  private scheduleEmitIfReady() {
    if (this.emitScheduled) return;
    // Require mandatory fields before first emit
    if (!this.latestAccel || !this.latestGyro || !this.latestMag || this.latestTemp === null) return;
    this.emitScheduled = true;
    
    queueMicrotask(() => {
      this.emitScheduled = false;
      const packet: SensorData = {
        accel: this.latestAccel!,
        gyro: this.latestGyro!,
        mag: this.latestMag!,
        gyroInt: this.latestGyroInt!,
        fusion: this.latestFusion!,
        fusionMag: this.latestFusionMag!,
        temperature: this.latestTemp!,
        t: this.latestTimeSec ?? 0,
      };
      this.emit('data', packet);
    });
  }
}