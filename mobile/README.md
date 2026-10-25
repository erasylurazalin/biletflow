# BiletFlow mobile

Mobile front-end built using React Native and Expo framework. Currently implemented:
   * Main page: lists public events
   * Event page: event details
   * Check-in page: post request to the api and works based on the response

Requires starting the API from the root first: `docker compose up -d db`, `npm run migrate`, `npm run seed`, `npm run dev`.

To start the app:
```
cd mobile
npm ci
npx expo start
```

Opens on exp://[dev server's local IP address]:8081 on mobile or http://localhost:8081 on web (for testing)

In the output, you'll find options to open the app in a
- [development build](https://docs.expo.dev/develop/development-builds/introduction/)
- [Android emulator](https://docs.expo.dev/workflow/android-studio-emulator/)
- [iOS simulator](https://docs.expo.dev/workflow/ios-simulator/)
- [Expo Go](https://expo.dev/go), a limited sandbox for trying out app development with Expo

