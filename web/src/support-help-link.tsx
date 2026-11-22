'use client';

// The public event page is rendered on the server and cannot read the localStorage
// session, so the Get help link is a client component that appears once a logged-in
// user is known. Logged-out visitors get nothing to click.
import Link from 'next/link';
import { useI18n } from '@/i18n/client';
import { useSessionUser } from '@/session';

export function SupportHelpLink({ href, className }: { href: string; className?: string }) {
  const user = useSessionUser();
  const { t } = useI18n();
  if (!user) return null;

  return (
    <Link href={href} className={className ?? 'text-sm font-medium underline'}>
      {t.support.getHelp}
    </Link>
  );
}
