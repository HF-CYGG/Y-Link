import { Tabs } from 'expo-router';

export default function TabsLayout() {
  return (
    <Tabs screenOptions={{ headerTitle: 'Y-Link Mobile' }}>
      <Tabs.Screen name="mall" options={{ title: '商城' }} />
      <Tabs.Screen name="orders" options={{ title: '订单' }} />
      <Tabs.Screen name="feedback" options={{ title: '反馈' }} />
      <Tabs.Screen name="profile" options={{ title: '我的' }} />
    </Tabs>
  );
}
