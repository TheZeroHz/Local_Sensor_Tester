export interface SensorData {
  accel: { x: number; y: number; z: number };
  gyro: { x: number; y: number; z: number };
  mag: { x: number; y: number; z: number }; // Added magnetometer
  gyroInt: { roll: number; pitch: number; yaw: number };
  fusion: { roll: number; pitch: number; yaw: number };
  fusionMag: { roll: number; pitch: number; yaw: number }; // Added AHRS with magnetometer
  temperature: number;
  t: number; // absolute device time in seconds since boot (from firmware)
}