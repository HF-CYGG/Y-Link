import { PlatformCapabilityNotConfiguredError } from './errors';

export type NotificationPermissionStatus = 'granted' | 'denied' | 'undetermined';

export interface NotificationCapability {
  getPermissionStatus(): Promise<NotificationPermissionStatus>;
  registerDevice(): Promise<string>;
}

export const notificationCapability: NotificationCapability = {
  getPermissionStatus() {
    return Promise.reject(new PlatformCapabilityNotConfiguredError('notifications'));
  },
  registerDevice() {
    return Promise.reject(new PlatformCapabilityNotConfiguredError('notifications'));
  },
};
