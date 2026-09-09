/**
 * App entry point. Starts the HTTP server. That is all it does.
 */
import 'dotenv/config';
import { createApp } from './app';

const port = Number(process.env.PORT ?? 3000);

createApp().listen(port, () => {
  console.log(`BiletFlow API listening on http://localhost:${port}`);
});
