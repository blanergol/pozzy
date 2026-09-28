// Мок expo-speech-recognition для jest: нативный модуль в рантайме тестов отсутствует.
module.exports = {
  ExpoSpeechRecognitionModule: {
    isRecognitionAvailable: () => false,
    requestPermissionsAsync: async () => ({ granted: false }),
    start: () => {},
    stop: () => {},
    abort: () => {},
    addListener: () => ({ remove: () => {} }),
  },
  useSpeechRecognitionEvent: () => {},
};
