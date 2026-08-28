'use client';

import { useState } from 'react';
import { Modal } from '@/components/ui';
import { BACKDATE_REASONS, BACKDATE_REASON_LABELS, type BackdateReason } from '@/lib/types';

interface BackdateDialogProps {
  open: boolean;
  date: string;
  onConfirm: (reason: BackdateReason) => void;
  onCancel: () => void;
}

export function BackdateDialog({ open, date, onConfirm, onCancel }: BackdateDialogProps) {
  const [reason, setReason] = useState<BackdateReason>('forgot_to_record');

  return (
    <Modal
      open={open}
      title="Backdated entry"
      onClose={onCancel}
      footer={
        <>
          <button className="btn-secondary" onClick={onCancel} type="button">
            Cancel
          </button>
          <button className="btn-primary" onClick={() => onConfirm(reason)} type="button">
            Continue
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
          <p className="font-medium">⚠ Backdated transaction</p>
          <p className="mt-1">
            You are recording a transaction for <strong>{date}</strong>. This is a backdated entry. Continue?
          </p>
        </div>

        <div>
          <label className="label">Reason for backdating</label>
          <select
            className="input"
            value={reason}
            onChange={(e) => setReason(e.target.value as BackdateReason)}
          >
            {BACKDATE_REASONS.map((r) => (
              <option key={r} value={r}>
                {BACKDATE_REASON_LABELS[r]}
              </option>
            ))}
          </select>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Helper: check if a date string is before today.
 */
export function isBackdated(dateStr: string): boolean {
  if (!dateStr) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const date = new Date(dateStr);
  date.setHours(0, 0, 0, 0);
  return date < today;
}

/**
 * Get today's date as YYYY-MM-DD.
 */
export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
