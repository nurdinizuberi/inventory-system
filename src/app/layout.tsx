import type { Metadata } from 'next';
import { AuthProvider } from '@/components/auth-context';
import { ThemeProvider } from '@/components/theme-context';
import { Toaster } from '@/components/toast';
import './globals.css';

export const metadata: Metadata = {
  title: 'MindBoxAfrica — Warehouse & Retail Inventory',
  description:
    'MindBoxAfrica: Inventory management across the full flow: purchase → warehouse → transfer → retail store → POS → reports & audit.',
};

// Applied before first paint to avoid a light/dark flash. Mirrors the logic in
// src/components/theme-context.tsx (keep the two in sync).
const themeBootstrap = `(function(){try{var t=localStorage.getItem('ims-theme');var d=t?t==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches;var r=document.documentElement;r.classList.toggle('dark',d);r.style.colorScheme=d?'dark':'light';}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
        <ThemeProvider>
          <AuthProvider>
            <Toaster>{children}</Toaster>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
