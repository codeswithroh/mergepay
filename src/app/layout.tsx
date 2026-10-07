import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'MergePay',
  description: 'Bounty platform for GitHub repositories',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
