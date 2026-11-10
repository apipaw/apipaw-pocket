// ethers v6 在原生端需要 `crypto.getRandomValues` —— RN 没有 WebCrypto，
// 必须**在任何业务模块之前**注入这个 polyfill，否则 import ethers 就会炸。
import 'react-native-get-random-values';

import { registerRootComponent } from 'expo';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
