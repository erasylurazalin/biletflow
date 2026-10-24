import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AuthForm } from '@/auth-form';

export const metadata: Metadata = {
  title: 'Register · BiletFlow',
};

export default function RegisterPage() {
  return (
    <Suspense>
      <AuthForm mode="register" />
    </Suspense>
  );
}
