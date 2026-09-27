# Pozzy — иконки приложения

Концепция: буква P, собранная из листа заметки с загнутым углом. Загиб — жёлтая «изнанка» стикера.

## Палитра
| Роль | HEX |
|---|---|
| Фон, светлый край градиента | #12806F |
| Фон, тёмный край градиента | #0A4A42 |
| Лист / буква | #FFFFFF |
| Загиб | #FFC23D |
| Лист в тёмной теме iOS | #7BE3CF |

## Куда класть
**iOS (Xcode 16+):** заменить `AppIcon.appiconset` целиком из `ios/`. Внутри светлая, тёмная (прозрачный фон) и tinted-версии.
Для Liquid Glass в Icon Composer: слои из `ios/IconComposer-layers/`, фон — градиент #12806F → #0A4A42.

**Android (нативно):** содержимое `android/res/` скопировать в `app/src/main/res/`. Адаптивная иконка векторная,
с monochrome-слоем для themed icons (Android 13+). PNG в `mipmap-*` — только для API < 26.

**Flutter (flutter_launcher_icons) / Expo:** PNG-слои 1024 px в `android/adaptive-png/`, общий 1024 px — `store/app-store-1024.png`.

**Сторы:** `store/google-play-512.png`, `store/app-store-1024.png`.

Исходники — `source/*.svg`.
