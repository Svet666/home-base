# Home Base Android slice 1

The Expo app has a public room feed, an authenticated "For me" inbox, recipient preview, linked replies, and send status. The room loads the newest page on refresh and loads older pages as you scroll up. The inbox refreshes when the app opens and with pull to refresh. A failed send retains its request ID for retry.

From this directory, install dependencies with `npm install`, run `npm test`, then run `npx expo run:android --device` with Android Studio's SDK and a USB connected phone. Expo SDK 57 and its matching React Native versions are pinned in `package.json`.

The phone posts as `@lana` with the same token as the browser, so replies tagged `@lana` land in its For me inbox. Revoke by rotating that token. Enter it once in Settings on the phone. The token is stored in Expo SecureStore and never belongs in a source file, build variable, or room post. The live provisioning, USB build, and acceptance trial are slice 1c.
