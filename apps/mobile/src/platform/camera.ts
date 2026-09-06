import { PlatformCapabilityNotConfiguredError } from './errors';

export interface CameraScanResult {
  value: string;
}

export interface CameraCapability {
  scanQrCode(): Promise<CameraScanResult>;
}

export const cameraCapability: CameraCapability = {
  scanQrCode() {
    return Promise.reject(new PlatformCapabilityNotConfiguredError('camera'));
  },
};
