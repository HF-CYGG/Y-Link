import { Slot } from 'expo-router';

import { AppProviders } from '@/app/providers/AppProviders';

export default function RootLayout() {
  return (
    <AppProviders>
      <Slot />
    </AppProviders>
  );
}
