import React from 'react';
import { Tabs } from 'expo-router';
import { theme } from '../../src/theme';
import { BottomTabIcon } from '../../src/components/BottomTabIcon';

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.colors.primary,
        tabBarInactiveTintColor: theme.colors.subtext,
        tabBarStyle: {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.divider,
          elevation: 8,
          shadowOpacity: 0.1,
          shadowRadius: 10,
          paddingBottom: 4,
        },
      }}
    >
      <Tabs.Screen
        name="mall"
        options={{
          title: '商城',
          tabBarIcon: ({ color, focused }) => (
            <BottomTabIcon name="mall" color={color} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="orders"
        options={{
          title: '订单',
          tabBarIcon: ({ color, focused }) => (
            <BottomTabIcon name="orders" color={color} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="feedback"
        options={{
          title: '反馈',
          tabBarIcon: ({ color, focused }) => (
            <BottomTabIcon name="feedback" color={color} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: '我的',
          tabBarIcon: ({ color, focused }) => (
            <BottomTabIcon name="profile" color={color} focused={focused} />
          ),
        }}
      />
    </Tabs>
  );
}
