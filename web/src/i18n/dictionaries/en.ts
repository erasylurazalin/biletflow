// The English dictionary. It also defines the shape: kk.ts and ru.ts must have every
// key this file has, or the typecheck fails. {name} is a placeholder, filled by fill().

import type { Plural } from '../format';

export const en = {
  meta: {
    description: 'Event tickets in Kazakhstan',
    login: 'Log in · BiletFlow',
    register: 'Register · BiletFlow',
  },
  calendar: {
    dateTime: '{day} {month} {year}, {time}',
    months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  },
  common: {
    genericError: 'Something went wrong. Try again.',
    pleaseWait: 'Please wait…',
    loading: 'Loading…',
    free: 'Free',
    email: 'Email',
    status: 'Status: {status}',
    total: 'Total: {amount}',
    openInbox: 'Open the simulated inbox',
    missingToken: 'This link is missing its token.',
  },
  header: {
    account: 'Account',
    verifyEmail: 'Verify your email',
    myTickets: 'My tickets',
    myOrders: 'My orders',
    logOut: 'Log out',
    logIn: 'Log in',
    register: 'Register',
    language: 'Language',
  },
  home: {
    title: 'Events',
    empty: 'No published events yet.',
    loadError: 'Something went wrong loading events.',
    unavailable: 'The events API is unavailable',
  },
  event: {
    back: '← Events',
    refundPolicy: 'Refund policy',
    organizer: 'Organizer: {name}',
    tickets: 'Tickets',
    noTickets: 'No tickets on sale.',
    loadError: 'Something went wrong loading this event.',
    notFoundTitle: 'Event not found',
    notFoundText: 'That event is not published, or the link is wrong.',
  },
  picker: {
    soldOut: 'Sold out',
    notOnSaleYet: 'Not on sale yet',
    onSaleFrom: 'On sale from {when}',
    salesEnded: 'Sales ended',
    left: { one: '{count} left', other: '{count} left' } as Plural,
    quantityFor: 'Quantity for {name}',
    attendeeName: '{name}, ticket {number}: attendee name',
    yourName: 'Your name',
    promoCode: 'Promo code',
    promoPlaceholder: 'Enter a promo code',
    promoApplied: 'Code {code} applied: {discount} off {tickets}',
    allTickets: 'all tickets',
    creating: 'Creating order…',
    register: 'Register',
    continue: 'Continue to payment',
    tooMany: 'At most 10 tickets per order',
  },
  auth: {
    logInTitle: 'Log in',
    registerTitle: 'Create an account',
    name: 'Name',
    password: 'Password',
    logIn: 'Log in',
    createAccount: 'Create account',
    haveAccount: 'Already have an account? Log in',
    noAccount: 'Create an account',
    forgotPassword: 'Forgot password?',
  },
  checkout: {
    notFound: 'Order not found',
    loading: 'Loading order…',
    back: '← Event',
    quantity: 'Quantity: {count}',
    each: '{price} each',
    tickets: 'Tickets: {amount}',
    discount: 'Discount ({code}): -{amount}',
    discountNoCode: 'promo',
    processingCharge: 'Processing charge (3%): {amount}',
    reservedUntil: 'Reserved until {when}',
    demoNotice: 'Demonstration payment. No real money is charged and no card details are needed.',
    processing: 'Processing…',
    confirm: 'Confirm registration',
    pay: 'Pay {amount} (simulated)',
    simulateFailure: 'Simulate a failed payment',
    expired: 'This reservation expired. Go back to the event to try again.',
    backToEvent: 'Back to the event',
    success: "You're in.",
    simulatedPayment: 'Simulated payment of {amount} · {when}',
    cancelled: 'This order was cancelled.',
    refunded: 'This order was refunded.',
    refundedOn: 'Refunded {amount} (simulated) on {when}.',
  },
  orders: {
    title: 'My orders',
    loading: 'Loading orders…',
    empty: 'No orders yet.',
    view: 'View',
  },
  tickets: {
    title: 'My tickets',
    loading: 'Loading tickets…',
    empty: 'No tickets yet.',
    browse: 'Browse events',
    preparing: 'Preparing…',
    downloadPdf: 'Download PDF',
    pdfError: 'Could not prepare the PDF. Try again.',
    qrAlt: 'Ticket QR code',
  },
  orderStatus: {
    pending: 'Awaiting payment',
    paid: 'Paid',
    cancelled: 'Cancelled',
    refunded: 'Refunded',
  },
  ticketStatus: {
    valid: 'Valid',
    checked_in: 'Checked in',
    cancelled: 'Cancelled',
    refunded: 'Refunded',
  },
  inbox: {
    title: 'Inbox (simulated)',
    intro: 'BiletFlow does not send real email in this demo. Every message it would send appears here.',
    empty: 'No emails yet.',
    loading: 'Loading emails…',
    sending: 'Sending…',
    resend: 'Send a new verification link',
    show: 'Show emails',
  },
  forgotPassword: {
    title: 'Reset your password',
    sent: 'If an account exists for that email, we sent a reset link.',
    submit: 'Send reset link',
  },
  resetPassword: {
    title: 'Set a new password',
    newPassword: 'New password',
    submit: 'Set new password',
  },
  verifyEmail: {
    verified: 'Your email is verified.',
    home: 'Go to the home page',
    verifying: 'Verifying your email…',
  },
  errors: {
    unreachable:
      'Could not reach the API. From the repo root, run: docker compose up -d db, npm run migrate, npm run seed, npm run dev.',
    // Empty: English shows the API's own message, which names the ticket type.
    soldOut: '',
    salesClosed: '',
  },
  // The API answers in English (docs/api.md: the frontend shows `message` as it is).
  // The other languages map the exact English messages people meet on these pages to
  // their own; anything not listed is shown in English.
  apiMessages: {} as Record<string, string>,
};

type Widen<T> = T extends string
  ? string
  : T extends Plural
    ? Plural
    : string extends keyof T
      ? T // apiMessages, an open map
      : { [K in keyof T]: Widen<T[K]> };

export type Dictionary = Widen<typeof en>;
