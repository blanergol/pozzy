import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { jest, describe, it, expect } from '@jest/globals';
import OnboardingScreen from '../OnboardingScreen';

// Mock safe-area: the test has no SafeAreaProvider
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

describe('OnboardingScreen', () => {
  it('рендерит слайды и вызывает onFinish по кнопке «Начать»', async () => {
    const onFinish = jest.fn();
    let tree: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderer.create(<OnboardingScreen onFinish={onFinish} />);
    });
    const flat = tree!.root
      .findAllByType(require('react-native').Text)
      .map((n) => String(n.props.children ?? ''))
      .join('\n');
    // titles of the three slides (default locale is ru)
    expect(flat).toContain('Ваши заметки. Ваш сервер.');
    expect(flat).toContain('Всё для работы с заметками');
    expect(flat).toContain('AI-агент — ваш помощник');

    const startBtn = tree!.root.findByProps({ accessibilityLabel: 'onboarding-start' });
    await act(async () => {
      startBtn.props.onPress();
    });
    expect(onFinish).toHaveBeenCalledTimes(1);
  });
});
