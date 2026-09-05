export type PlatformCapabilityName = 'camera' | 'image-picker' | 'notifications' | 'deep-link';

export class PlatformCapabilityNotConfiguredError extends Error {
  readonly capability: PlatformCapabilityName;

  constructor(capability: PlatformCapabilityName) {
    super(`平台能力尚未配置：${capability}`);
    this.name = 'PlatformCapabilityNotConfiguredError';
    this.capability = capability;
  }
}
