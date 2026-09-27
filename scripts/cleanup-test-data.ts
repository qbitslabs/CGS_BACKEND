/**
 * Wipe conversations, leads, and patients (+ related appointments/messages) from CGS.
 *
 * Usage (from backend/CGS_Backend):
 *   npx tsx scripts/cleanup-test-data.ts --dry-run
 *   npx tsx scripts/cleanup-test-data.ts --confirm
 *   npx tsx scripts/cleanup-test-data.ts --confirm --clinicId=<uuid>
 *   npx tsx scripts/cleanup-test-data.ts --confirm --phone=919352890191
 *
 * Defaults to dry-run. Pass --confirm to actually delete.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function argValue(flag: string): string | undefined {
  const exact = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (exact) return exact.slice(flag.length + 1);
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1];
  }
  return undefined;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function phoneVariants(phone: string): string[] {
  const digits = phone.replace(/\D/g, '');
  if (!digits) return [phone];
  const variants = new Set<string>([digits, phone]);
  if (digits.length === 10) variants.add(`91${digits}`);
  if (digits.startsWith('91') && digits.length === 12) variants.add(digits.slice(2));
  if (digits.startsWith('0') && digits.length === 11) {
    variants.add(digits.slice(1));
    variants.add(`91${digits.slice(1)}`);
  }
  return [...variants];
}

async function main() {
  const confirm = hasFlag('--confirm');
  const dryRun = !confirm || hasFlag('--dry-run');
  const clinicId = argValue('--clinicId');
  const phone = argValue('--phone');
  const phones = phone ? phoneVariants(phone) : null;

  const clinicFilter = clinicId ? { clinicId } : {};
  const phoneFilter = phones ? { phone: { in: phones } } : {};
  const participantPhoneFilter = phones ? { participantPhone: { in: phones } } : {};

  const [leads, patients, conversations] = await Promise.all([
    prisma.lead.findMany({
      where: { ...clinicFilter, ...phoneFilter },
      select: { id: true, name: true, phone: true, source: true },
    }),
    prisma.patient.findMany({
      where: { ...clinicFilter, ...phoneFilter },
      select: { id: true, name: true, phone: true },
    }),
    prisma.conversation.findMany({
      where: { ...clinicFilter, ...participantPhoneFilter },
      select: {
        id: true,
        participantName: true,
        participantPhone: true,
        leadId: true,
        patientId: true,
      },
    }),
  ]);

  let allConversations = conversations;
  if (phones) {
    const extra = await prisma.conversation.findMany({
      where: {
        ...clinicFilter,
        OR: [
          { leadId: { in: leads.map((l) => l.id) } },
          { patientId: { in: patients.map((p) => p.id) } },
        ],
      },
      select: {
        id: true,
        participantName: true,
        participantPhone: true,
        leadId: true,
        patientId: true,
      },
    });
    const byId = new Map(allConversations.map((c) => [c.id, c]));
    for (const c of extra) byId.set(c.id, c);
    allConversations = [...byId.values()];
  }

  const conversationIds = allConversations.map((c) => c.id);
  const patientIds = patients.map((p) => p.id);
  const leadIds = leads.map((l) => l.id);

  const [messageCount, appointmentCount] = await Promise.all([
    conversationIds.length
      ? prisma.message.count({ where: { conversationId: { in: conversationIds } } })
      : Promise.resolve(0),
    patientIds.length
      ? prisma.appointment.count({ where: { patientId: { in: patientIds } } })
      : Promise.resolve(0),
  ]);

  console.log('\n=== CGS cleanup preview (conversations + leads + patients) ===');
  if (clinicId) console.log(`clinicId: ${clinicId}`);
  if (phone) console.log(`phone filter: ${phone} → ${phones?.join(', ')}`);
  console.log(`conversations:  ${allConversations.length}`);
  console.log(`messages:       ${messageCount}`);
  console.log(`leads:          ${leads.length}`);
  console.log(`patients:       ${patients.length}`);
  console.log(`appointments:   ${appointmentCount}`);

  if (leads.length) {
    console.log('\nLeads:');
    for (const l of leads.slice(0, 20)) {
      console.log(`  - ${l.name} | ${l.phone} | ${l.source} | ${l.id}`);
    }
    if (leads.length > 20) console.log(`  … +${leads.length - 20} more`);
  }

  if (patients.length) {
    console.log('\nPatients:');
    for (const p of patients.slice(0, 20)) {
      console.log(`  - ${p.name} | ${p.phone} | ${p.id}`);
    }
    if (patients.length > 20) console.log(`  … +${patients.length - 20} more`);
  }

  if (allConversations.length) {
    console.log('\nConversations:');
    for (const c of allConversations.slice(0, 20)) {
      console.log(`  - ${c.participantName} | ${c.participantPhone} | ${c.id}`);
    }
    if (allConversations.length > 20) console.log(`  … +${allConversations.length - 20} more`);
  }

  if (dryRun) {
    console.log('\nDry-run only. Re-run with --confirm to delete.\n');
    return;
  }

  if (!leadIds.length && !patientIds.length && !conversationIds.length) {
    console.log('\nNothing to delete.\n');
    return;
  }

  console.log('\nDeleting…');

  const result = await prisma.$transaction(async (tx) => {
    if (leadIds.length) {
      await tx.lead.updateMany({
        where: { id: { in: leadIds } },
        data: { convertedPatientId: null },
      });
    }

    if (conversationIds.length) {
      await tx.aiUsage.updateMany({
        where: { conversationId: { in: conversationIds } },
        data: { conversationId: null, messageId: null },
      });
      await tx.message.deleteMany({ where: { conversationId: { in: conversationIds } } });
    }

    const deletedConversations = conversationIds.length
      ? (await tx.conversation.deleteMany({ where: { id: { in: conversationIds } } })).count
      : 0;

    let deletedPayments = 0;
    let deletedInvoices = 0;
    let deletedAppointments = 0;

    if (patientIds.length) {
      const invoices = await tx.invoice.findMany({
        where: { patientId: { in: patientIds } },
        select: { id: true },
      });
      const invoiceIds = invoices.map((i) => i.id);
      if (invoiceIds.length) {
        const payments = await tx.payment.findMany({
          where: { invoiceId: { in: invoiceIds } },
          select: { id: true },
        });
        const paymentIds = payments.map((p) => p.id);
        if (paymentIds.length) {
          await tx.paymentAuthorization.deleteMany({ where: { paymentId: { in: paymentIds } } });
          deletedPayments = (await tx.payment.deleteMany({ where: { id: { in: paymentIds } } })).count;
        }
        await tx.invoiceItem.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
        deletedInvoices = (await tx.invoice.deleteMany({ where: { id: { in: invoiceIds } } })).count;
      }
      deletedAppointments = (
        await tx.appointment.deleteMany({ where: { patientId: { in: patientIds } } })
      ).count;
    }

    const deletedPatients = patientIds.length
      ? (await tx.patient.deleteMany({ where: { id: { in: patientIds } } })).count
      : 0;

    const deletedLeads = leadIds.length
      ? (await tx.lead.deleteMany({ where: { id: { in: leadIds } } })).count
      : 0;

    const entityIds = [...conversationIds, ...patientIds, ...leadIds];
    const deletedNotifications = entityIds.length
      ? (
          await tx.notification.deleteMany({
            where: {
              ...clinicFilter,
              entityId: { in: entityIds },
            },
          })
        ).count
      : 0;

    return {
      deletedConversations,
      deletedLeads,
      deletedPatients,
      deletedAppointments,
      deletedInvoices,
      deletedPayments,
      deletedNotifications,
    };
  });

  console.log('\n=== Deleted ===');
  console.log(result);
  console.log('');
}

main()
  .catch((err) => {
    console.error('\nCleanup failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
