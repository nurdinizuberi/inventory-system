import { NextResponse } from 'next/server';
import { guard, jsonError, ALL_ACTIONS, type Action } from '@/lib/rbac';

const ACTION_GROUPS: Record<string, { label: string; actions: Action[] }> = {
  catalog: {
    label: 'Catalog',
    actions: ['product.view', 'product.create', 'product.update', 'product.delete', 'variant.view', 'variant.create', 'variant.update', 'variant.delete'],
  },
  locations: {
    label: 'Locations & Suppliers',
    actions: ['location.view', 'location.manage', 'supplier.view', 'supplier.manage'],
  },
  users: {
    label: 'Users & Roles',
    actions: ['user.view', 'user.manage'],
  },
  purchasing: {
    label: 'Purchasing',
    actions: ['purchase.view', 'purchase.create', 'purchase.update', 'purchase.confirm', 'purchase.cancel'],
  },
  transfers: {
    label: 'Transfers',
    actions: ['transfer.view', 'transfer.create', 'transfer.ship', 'transfer.complete', 'transfer.cancel'],
  },
  sales: {
    label: 'Sales (POS)',
    actions: ['sale.create', 'sale.view', 'sale.void', 'sale.ownOnly'],
  },
  returns: {
    label: 'Returns',
    actions: ['return.create', 'return.view'],
  },
  stock: {
    label: 'Stock & Reservations',
    actions: ['stock.view', 'stock.adjust', 'stock.adjustApprove', 'reservation.manage'],
  },
  reports: {
    label: 'Reports',
    actions: ['report.sales', 'report.stock', 'report.purchases', 'report.transfers', 'report.pnl', 'report.valuation'],
  },
  system: {
    label: 'System',
    actions: ['audit.view'],
  },
};

const ACTION_LABELS: Record<string, string> = {
  'product.view': 'View products',
  'product.create': 'Create products',
  'product.update': 'Edit products',
  'product.delete': 'Delete / archive products',
  'variant.view': 'View variants',
  'variant.create': 'Create variants',
  'variant.update': 'Edit variants',
  'variant.delete': 'Delete variants',
  'location.view': 'View locations',
  'location.manage': 'Manage locations',
  'supplier.view': 'View suppliers',
  'supplier.manage': 'Manage suppliers',
  'user.view': 'View users',
  'user.manage': 'Manage users & roles',
  'purchase.view': 'View purchases',
  'purchase.create': 'Create purchase orders',
  'purchase.update': 'Edit purchase orders',
  'purchase.confirm': 'Confirm & receive purchases',
  'purchase.cancel': 'Cancel purchases',
  'transfer.view': 'View transfers',
  'transfer.create': 'Create transfers',
  'transfer.ship': 'Ship transfers',
  'transfer.complete': 'Complete / receive transfers',
  'transfer.cancel': 'Cancel transfers',
  'sale.create': 'Create sales (POS)',
  'sale.view': 'View sales',
  'sale.void': 'Void sales',
  'sale.ownOnly': 'See own sales only',
  'return.create': 'Create returns',
  'return.view': 'View returns',
  'stock.view': 'View stock ledger',
  'stock.adjust': 'Create stock adjustments',
  'stock.adjustApprove': 'Approve stock adjustments',
  'reservation.manage': 'Manage reservations',
  'report.sales': 'Sales report',
  'report.stock': 'Stock report',
  'report.purchases': 'Purchase history report',
  'report.transfers': 'Transfer history report',
  'report.pnl': 'Profit & loss report',
  'report.valuation': 'Inventory valuation report',
  'audit.view': 'View audit log',
};

export async function GET() {
  try {
    await guard({ action: 'user.manage' });
    return NextResponse.json({
      groups: Object.entries(ACTION_GROUPS).map(([key, group]) => ({
        key,
        label: group.label,
        actions: group.actions.map((action) => ({
          action,
          label: ACTION_LABELS[action] ?? action,
        })),
      })),
    });
  } catch (err) {
    return jsonError(err);
  }
}
