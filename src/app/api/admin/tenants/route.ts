import { NextResponse } from 'next/server';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/db';
import { requireAdmin } from '@/lib/admin-auth';
import { badRequest, conflict, jsonError } from '@/lib/rbac';
import { SYSTEM_ROLES } from '@/lib/rbac';
import { getAppBaseUrl } from '@/lib/app-url';
import { sendEmail } from '@/lib/email';
import { issueVerificationForEmail } from '@/lib/tokens';

const createSchema = z.object({
  name: z.string().min(2, 'Organization name is required'),
  slug: z
    .string()
    .min(2, 'Subdomain is required')
    .regex(/^[a-z0-9-]+$/, 'Subdomain must be lowercase letters, numbers, and hyphens'),
  adminEmail: z.string().email('Admin email is required'),
  adminName: z.string().min(2, 'Admin name is required'),
  adminPassword: z.string().min(6, 'Password must be at least 6 characters'),
});

export async function GET() {
  try {
    const admin = await requireAdmin();
    if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const tenants = await prisma.tenant.findMany({
      include: {
        _count: {
          select: {
            users: true,
            locations: true,
            products: true,
            sales: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json({
      tenants: tenants.map((t) => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        isActive: t.isActive,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        userCount: t._count.users,
        locationCount: t._count.locations,
        productCount: t._count.products,
        salesCount: t._count.sales,
      })),
    });
  } catch (err) {
    return jsonError(err);
  }
}

export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const parsed = createSchema.safeParse(await request.json());
    if (!parsed.success) {
      return badRequest(parsed.error.issues.map((i) => i.message).join(', '));
    }

    const data = parsed.data;

    // Check slug uniqueness
    const existing = await prisma.tenant.findUnique({ where: { slug: data.slug } });
    if (existing) {
      return conflict('A tenant with that subdomain already exists');
    }

    // Create tenant with admin user and default roles in a transaction
    const result = await prisma.$transaction(async (tx) => {
      // 1. Create the tenant
      const tenant = await tx.tenant.create({
        data: {
          name: data.name.trim(),
          slug: data.slug.toLowerCase(),
          isActive: true,
        },
      });

      // 2. Create default roles for the tenant
      const roleMap: Record<string, string> = {};
      for (const sys of SYSTEM_ROLES) {
        const role = await tx.role.create({
          data: {
            tenantId: tenant.id,
            name: sys.name,
            slug: sys.slug,
            description: sys.description,
            isSystemRole: true,
            permissions: {
              create: sys.permissions.map((action) => ({ action })),
            },
          },
        });
        roleMap[sys.slug] = role.id;
      }

      // 3. Create the Tenant Admin user
      const passwordHash = await bcrypt.hash(data.adminPassword, 10);
      const adminUser = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: data.adminEmail.toLowerCase(),
          name: data.adminName.trim(),
          passwordHash,
          role: 'ADMIN',
          roleId: roleMap['ADMIN'],
        },
      });

      return { tenant, adminUser, roleCount: Object.keys(roleMap).length };
    });

    // Fire-and-forget verification email for the new tenant admin.
    void (async () => {
      try {
        const verified = await issueVerificationForEmail(result.adminUser.email);
        if (verified) {
          const link = `${await getAppBaseUrl()}/verify-email?token=${verified.token}`;
          await sendEmail({
            to: verified.user.email,
            subject: 'Verify your MindBoxAfrica account email',
            html: `<p>Welcome to MindBoxAfrica. Verify your email to activate your admin account:</p><p><a href="${link}">${link}</a></p>`,
          });
        }
      } catch {
        /* noop */
      }
    })();

    return NextResponse.json(
      {
        tenant: {
          id: result.tenant.id,
          name: result.tenant.name,
          slug: result.tenant.slug,
          isActive: result.tenant.isActive,
          createdAt: result.tenant.createdAt,
        },
        adminUser: {
          id: result.adminUser.id,
          email: result.adminUser.email,
          name: result.adminUser.name,
        },
        defaultRolesCreated: result.roleCount,
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof Error && err.message.includes('Unique constraint')) {
      return conflict('A tenant with that subdomain already exists');
    }
    return jsonError(err);
  }
}
