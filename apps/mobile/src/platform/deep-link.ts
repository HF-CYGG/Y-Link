import { PlatformCapabilityNotConfiguredError } from './errors';

export interface DeepLinkCapability {
  getInitialUrl(): Promise<string | null>;
  subscribe(listener: (url: string) => void): () => void;
}

export const deepLinkCapability: DeepLinkCapability = {
  getInitialUrl() {
    return Promise.reject(new PlatformCapabilityNotConfiguredError('deep-link'));
  },
  subscribe(_listener) {
    throw new PlatformCapabilityNotConfiguredError('deep-link');
  },
};
