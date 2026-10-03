// expo-speech-recognition mock for jest: the native module is absent in the test runtime.
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
