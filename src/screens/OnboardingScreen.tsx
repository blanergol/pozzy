import React, { useRef, useState } from 'react';
import {
  FlatList,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useI18n } from '../i18n';

// Фирменная палитра (как в иконке приложения) — онбординг не зависит от темы
const BRAND_DARK = '#0A4A42';
const BRAND_LIGHT = '#12806F';
const BRAND_YELLOW = '#FFC23D';
const TEXT = 'rgba(255,255,255,0.92)';
const TEXT_FAINT = 'rgba(255,255,255,0.6)';

const FEATURE_ICONS = [
  'document-text-outline',
  'folder-outline',
  'cloud-offline-outline',
  'alarm-outline',
] as const;

function LogoGraphic() {
  return (
    <View style={styles.logoCircle}>
      <Image
        source={require('../../assets/icons/store/app-store-1024.png')}
        style={styles.logo}
      />
    </View>
  );
}

function FeaturesGraphic() {
  return (
    <View style={styles.featuresGrid}>
      {FEATURE_ICONS.map((name) => (
        <View key={name} style={styles.featureCircle}>
          <Ionicons name={name} size={30} color="#ffffff" />
        </View>
      ))}
    </View>
  );
}

function AiGraphic({ example }: { example: string }) {
  return (
    <View style={styles.aiWrap}>
      <View style={styles.aiCircle}>
        <Ionicons name="sparkles" size={34} color={BRAND_DARK} />
      </View>
      <View style={styles.chatBubble}>
        <Text style={styles.chatText}>{example}</Text>
        <View style={styles.chatTail} />
      </View>
    </View>
  );
}

interface SlideData {
  key: string;
  graphic: React.ReactNode;
  title: string;
  text?: string;
  bullets?: string[];
  hint?: string;
}

export default function OnboardingScreen({ onFinish }: { onFinish: () => void }) {
  const { t } = useI18n();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [page, setPage] = useState(0);
  const listRef = useRef<FlatList<SlideData>>(null);
  // Высота слайда = окно минус инсеты и панель точек (иначе на web
  // flex-растяжение не срабатывает и контент прижимается к верху)
  const slideHeight = height - insets.top - insets.bottom - 16 - 40;

  const slides: SlideData[] = [
    {
      key: 'about',
      graphic: <LogoGraphic />,
      title: t('onboarding.slide1.title'),
      text: t('onboarding.slide1.text'),
    },
    {
      key: 'features',
      graphic: <FeaturesGraphic />,
      title: t('onboarding.slide2.title'),
      bullets: [
        t('onboarding.slide2.item1'),
        t('onboarding.slide2.item2'),
        t('onboarding.slide2.item3'),
        t('onboarding.slide2.item4'),
      ],
    },
    {
      key: 'ai',
      graphic: <AiGraphic example={t('onboarding.slide3.example')} />,
      title: t('onboarding.slide3.title'),
      text: t('onboarding.slide3.text'),
      hint: t('onboarding.slide3.hint'),
    },
  ];

  const renderSlide = ({ item, index }: { item: SlideData; index: number }) => (
    <View style={[styles.slide, { width, height: slideHeight }]}>
      <View style={styles.graphicArea}>{item.graphic}</View>
      <Text style={styles.title}>{item.title}</Text>
      {item.text ? <Text style={styles.text}>{item.text}</Text> : null}
      {item.bullets ? (
        <View style={styles.bullets}>
          {item.bullets.map((line) => (
            <View key={line} style={styles.bulletRow}>
              <View style={styles.bulletDot} />
              <Text style={styles.bulletText}>{line}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {item.hint ? <Text style={styles.hint}>{item.hint}</Text> : null}
      {index === slides.length - 1 ? (
        <TouchableOpacity
          style={styles.startButton}
          onPress={onFinish}
          activeOpacity={0.85}
          accessibilityLabel="onboarding-start"
        >
          <Text style={styles.startButtonText}>{t('onboarding.start')}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );

  return (
    <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom + 16 }]}>
      {/* декоративные круги — имитация градиента фирменной палитры */}
      <View style={styles.bgCircleTop} />
      <View style={styles.bgCircleBottom} />

      <FlatList
        ref={listRef}
        data={slides}
        renderItem={renderSlide}
        keyExtractor={(item) => item.key}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        bounces={false}
        onMomentumScrollEnd={(e) => setPage(Math.round(e.nativeEvent.contentOffset.x / width))}
        getItemLayout={(_, index) => ({ length: width, offset: width * index, index })}
      />

      <View style={styles.dots}>
        {slides.map((s, i) => (
          <View key={s.key} style={[styles.dot, i === page && styles.dotActive]} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BRAND_DARK, overflow: 'hidden' },
  bgCircleTop: {
    position: 'absolute',
    top: -140,
    right: -120,
    width: 340,
    height: 340,
    borderRadius: 170,
    backgroundColor: BRAND_LIGHT,
    opacity: 0.45,
  },
  bgCircleBottom: {
    position: 'absolute',
    bottom: -180,
    left: -140,
    width: 380,
    height: 380,
    borderRadius: 190,
    backgroundColor: BRAND_LIGHT,
    opacity: 0.25,
  },
  slide: { flex: 1, paddingHorizontal: 32, justifyContent: 'center' },
  graphicArea: { alignItems: 'center', marginBottom: 40 },

  logoCircle: {
    width: 200,
    height: 200,
    borderRadius: 100,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  logo: { width: 150, height: 150, borderRadius: 34 },

  featuresGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    width: 200,
    justifyContent: 'center',
    gap: 18,
  },
  featureCircle: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  aiWrap: { alignItems: 'center', gap: 20 },
  aiCircle: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: BRAND_YELLOW,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chatBubble: {
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 12,
    maxWidth: 280,
  },
  chatTail: {
    position: 'absolute',
    top: -6,
    left: 28,
    width: 12,
    height: 12,
    backgroundColor: 'rgba(255,255,255,0.95)',
    transform: [{ rotate: '45deg' }],
  },
  chatText: { color: BRAND_DARK, fontSize: 15, fontWeight: '600' },

  title: { color: '#ffffff', fontSize: 26, fontWeight: '800', textAlign: 'center', marginBottom: 16 },
  text: { color: TEXT, fontSize: 16, lineHeight: 24, textAlign: 'center' },
  bullets: { gap: 12, alignSelf: 'center' },
  bulletRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, maxWidth: 320 },
  bulletDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: BRAND_YELLOW,
    marginTop: 7,
  },
  bulletText: { color: TEXT, fontSize: 16, lineHeight: 22, flex: 1 },
  hint: { color: TEXT_FAINT, fontSize: 13, textAlign: 'center', marginTop: 20 },

  startButton: {
    marginTop: 36,
    alignSelf: 'center',
    backgroundColor: BRAND_YELLOW,
    borderRadius: 28,
    paddingHorizontal: 48,
    paddingVertical: 14,
  },
  startButtonText: { color: BRAND_DARK, fontSize: 17, fontWeight: '800' },

  dots: { flexDirection: 'row', justifyContent: 'center', gap: 8, paddingVertical: 16 },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.35)',
  },
  dotActive: { backgroundColor: BRAND_YELLOW, width: 22 },
});
