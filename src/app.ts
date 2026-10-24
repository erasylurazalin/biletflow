/**
 * Builds the Express app and mounts the routes.
 *
 * Kept separate from index.ts so tests can import the app and make requests against it
 * without opening a real TCP port. index.ts is the only place that calls listen().
 *
 * To add a feature: write src/routes/<thing>.ts modelled on routes/events.ts, then add
 * one line here. Order matters: routes first, then notFoundHandler, then errorHandler
 * last, because Express runs middleware in the order it was mounted.
 */
import express from 'express';
import { authRouter } from './routes/auth';
import { checkInRouter } from './routes/check-in';
import { eventsRouter } from './routes/events';
import { meRouter } from './routes/me';
import { ordersRouter } from './routes/orders';
import { paidSalesRouter } from './routes/paid-sales';
import { staffRouter } from './routes/staff';
import { ticketTypesRouter } from './routes/ticket-types';
import { ticketsRouter } from './routes/tickets';
import { errorHandler, notFoundHandler } from './middleware/error-handler';

export function createApp() {
  const app = express();

  app.use(express.json());

  // Cheap "is the server up" check for Docker, the frontend and your own curl.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/events', eventsRouter);
  app.use('/api/me', meRouter);
  app.use('/api/orders', ordersRouter);
  app.use('/api/tickets', ticketsRouter);
  app.use('/api', ticketTypesRouter);
  app.use('/api', staffRouter);
  app.use('/api', checkInRouter);
  app.use('/api', paidSalesRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
