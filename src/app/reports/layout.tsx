'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { Shell } from '@/components/shell';
import { useAuth } from '@/components/auth-context';

const REPORTS = [
  { href: '/reports/sales', label: 'Sales', permission: 'report.sales' },
  { href: '/reports/stock', label: 'Current stock', permission: 'report.stock' },
  { href: '/reports/expiry', label: 'Approaching expiry', permission: 'report.stock' },
  { href: '/reports/reorder', label: 'Reorder suggestions', permission: 'report.stock' },
  { href: '/reports/purchases', label: 'Purchase history', permission: 'report.purchases' },
  { href: '/reports/transfers', label: 'Transfer history', permission: 'report.transfers' },
  { href: '/reports/pnl', label: 'Profit & loss', permission: 'report.pnl' },
  { href: '/reports/valuation', label: 'Inventory valuation', permission: 'report.valuation' },
];

export default function ReportsLayout({ children }: { children: ReactNode }) {
  const { can } = useAuth();
  const pathname = usePathname();
  const visible = REPORTS.filter((report) => can(report.permission));

  return (
    <Shell>
      <div className="mb-5 flex flex-wrap gap-2 border-b border-ink-200 pb-3 dark:border-ink-700">
        {visible.map((report) => (
          <Link
            key={report.href}
            href={report.href}
            className={`btn btn-sm ${pathname.startsWith(report.href) ? 'btn-primary' : 'btn-secondary'}`}
          >
            {report.label}
          </Link>
        ))}
      </div>
      {children}
    </Shell>
  );
}
