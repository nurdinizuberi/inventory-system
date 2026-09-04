'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { currency, formatDate } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Report export helpers. CSV downloads a real file; PDF opens the browser's
// print dialog against a print-only document (Save as PDF), so no extra
// dependency is required. The printable document is portaled to <body> and
// styled by the @media print rules in globals.css.
// ---------------------------------------------------------------------------

type Cell = string | number | null | undefined;

function csvEscape(value: Cell): string {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function downloadCsv(filename: string, headers: string[], rows: Cell[][]) {
  const content = '\uFEFF' + [headers, ...rows].map((row) => row.map(csvEscape).join(',')).join('\r\n');
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export interface PrintBlock {
  title?: string;
  /** Optional <table> content supplied as raw column/row data. */
  headers?: string[];
  rows?: ReactNode[][];
  /** Free-form content (paragraphs, lists) when no table is wanted. */
  content?: ReactNode;
}

export interface PrintSpec {
  title: string;
  subtitle?: ReactNode;
  blocks: PrintBlock[];
}

/**
 * Hides the running app and prints a standalone report document (browser
 * "Save as PDF"). The dark theme is suspended for the duration of the print
 * so the paper copy is always light.
 */
function printDocument(spec: PrintSpec) {
  const root = document.documentElement;
  const hadDark = root.classList.contains('dark');
  const hadColorScheme = root.style.colorScheme;
  root.classList.remove('dark');
  root.style.colorScheme = 'light';
  // Let the browser paint the light snapshot, then open the dialog. Restore
  // afterwards (the dialog blocks JS, so this runs once it closes).
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      window.print();
      if (hadDark) root.classList.add('dark');
      root.style.colorScheme = hadColorScheme;
    });
  });
}

export function ReportPrint({ spec, onDone }: { spec: PrintSpec; onDone?: () => void }) {
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    if (!rendered) return;
    const timer = setTimeout(() => {
      printDocument(spec);
      // print() returns once the dialog closes (desktop browsers); unmount
      // the hidden print tree afterwards.
      onDone?.();
    }, 60);
    return () => clearTimeout(timer);
  }, [rendered, spec, onDone]);

  if (!rendered) return null;
  const now = new Date();
  return createPortal(
    <div id="print-root" className="p-8 text-sm text-ink-900">
      <div className="mb-4 border-b border-ink-300 pb-3">
        <h1 className="text-xl font-semibold">{spec.title}</h1>
        {spec.subtitle && <p className="mt-1 text-ink-600">{spec.subtitle}</p>}
        <p className="mt-1 text-xs text-ink-500">Generated {formatDate(now, true)}</p>
      </div>
      <div className="space-y-6">
        {spec.blocks.map((block, index) => (
          <section key={index}>
            {block.title && <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide">{block.title}</h2>}
            {block.content}
            {block.headers && (
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    {block.headers.map((header) => (
                      <th
                        key={header}
                        className="border-b border-ink-300 px-2 py-1.5 text-left text-xs font-semibold uppercase tracking-wide"
                      >
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows?.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.map((cell, cellIndex) => (
                        <td key={cellIndex} className="border-b border-ink-200 px-2 py-1.5 align-top">
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        ))}
      </div>
    </div>,
    document.body,
  );
}

export function ExportButtons({
  csvFilename,
  csvHeaders,
  csvRows,
  print,
  label = 'Export',
}: {
  csvFilename: string;
  csvHeaders: string[];
  csvRows: Cell[][];
  print: PrintSpec;
  label?: string;
}) {
  const [printing, setPrinting] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-ink-400 dark:text-ink-500">{label}</span>
      <button
        type="button"
        className="btn-secondary btn-sm"
        onClick={() => downloadCsv(csvFilename, csvHeaders, csvRows)}
      >
        CSV
      </button>
      <button type="button" className="btn-secondary btn-sm" onClick={() => setPrinting(true)}>
        PDF
      </button>
      {printing && <ReportPrint spec={print} onDone={() => setPrinting(false)} />}
    </div>
  );
}

/** Formatting helpers reused by export tables in report pages. */
export function money(v: number | null | undefined): string {
  return currency(v ?? 0);
}

export function pctText(v: number | null | undefined): string {
  return `${Number(v ?? 0).toFixed(1)}%`;
}
