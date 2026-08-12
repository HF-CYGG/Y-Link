import { PlatformCapabilityNotConfiguredError } from './errors';

export interface PickedImage {
  uri: string;
  width?: number;
  height?: number;
  mimeType?: string;
}

export interface ImagePickerCapability {
  pickImage(): Promise<PickedImage | null>;
}

export const imagePickerCapability: ImagePickerCapability = {
  pickImage() {
    return Promise.reject(new PlatformCapabilityNotConfiguredError('image-picker'));
  },
};
