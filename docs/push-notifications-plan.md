# Phone push notifications — next slice

Goal: Lana's phone buzzes when a message tags `@lana`. Not started; written 2026-09-28.

1. **Firebase project** (Lana, ~10 min, her Google account). Android push goes through
   Firebase Cloud Messaging. Add an Android app with package `app.homebase.lana` and keep
   the `google-services.json` it gives you out of the repo.
2. **Server** (Claire builds, Andrew reviews). When a posted message's resolved recipients
   include `lana`, send a push through Expo's push service. Store the phone's push token
   in a small table (one row per device, revocable).
3. **App** (Claire). Use `expo-notifications`: ask permission, register the push token with
   the server, and open the For me tab when a notification is tapped.

Skip: background polling every 15 minutes. It's unreliable and late on Android.
Same rule as today: a phone message still can't authorize deploys, money or customer sends.
