/* Prisma seed: sample WhatsApp threads for a clinic already in CGS.
 * Looks up existing clinic/doctor/patients; does not recreate the old full catalog. */
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding Conversations & Messages for Apex Super Specialty Dental & Healthcare Clinic...');
  console.log('🔍 Looking up Clinic, Doctor, Staff & Patients for Apex Super Specialty Clinic...');

  const clinic = await prisma.clinic.findFirst({
    where: { slug: 'apex-dental-hospital' },
  });

  if (!clinic) {
    throw new Error('Clinic "apex-dental-hospital" not found! Please run the initial clinic seed first.');
  }

  const doctorProfile = await prisma.doctor.findFirst({
    where: { clinicId: clinic.id },
  });

  const staffUser = await prisma.user.findFirst({
    where: { clinicId: clinic.id, role: 'EMPLOYEE' },
  });

  const whatsappAccount = await prisma.whatsappAccount.findFirst({
    where: { clinicId: clinic.id },
  });

  const patients = await prisma.patient.findMany({
    where: { clinicId: clinic.id },
    orderBy: { createdAt: 'asc' },
  });

  const leads = await prisma.lead.findMany({
    where: { clinicId: clinic.id },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`Found Clinic: ${clinic.name}`);
  console.log(`Found Doctor: ${doctorProfile ? 'Dr. Rajesh Sharma' : 'None'}`);
  console.log(`Found Patients: ${patients.length}`);

  // Fallback IDs if needed
  const doctorId = doctorProfile?.id;
  const staffId = staffUser?.id;
  const whatsappAccountId = whatsappAccount?.id;

  const now = new Date();

  // -------------------------------------------------------------------------
  // CONVERSATION 1: Pooja Deshmukh (AI_ACTIVE - Booking Whitening)
  // -------------------------------------------------------------------------
  const p1 = patients[0] || { name: 'Pooja Deshmukh', phone: '+91 98111 22334', id: undefined };
  const conv1Time = new Date(now.getTime() - 25 * 60000); // 25 mins ago

  const conv1 = await prisma.conversation.create({
    data: {
      clinicId: clinic.id,
      patientId: p1.id,
      doctorId: doctorId,
      whatsappAccountId: whatsappAccountId,
      participantName: p1.name,
      participantPhone: p1.phone,
      state: 'AI_ACTIVE',
      unreadCount: 0,
      serviceInterested: 'Laser Teeth Whitening',
      lastMessageText: 'Your appointment is confirmed with Dr. Rajesh Sharma for today at 10:30 AM. See you soon!',
      lastMessageAt: new Date(conv1Time.getTime() + 4 * 60000),
      lastActivityAt: new Date(conv1Time.getTime() + 4 * 60000),
    },
  });

  await prisma.message.createMany({
    data: [
      {
        clinicId: clinic.id,
        conversationId: conv1.id,
        whatsappAccountId: whatsappAccountId,
        direction: 'INBOUND',
        senderType: 'PATIENT',
        senderName: p1.name,
        content: 'Hi! Could you tell me how much laser teeth whitening costs with Dr. Rajesh Sharma?',
        status: 'READ',
        isAiGenerated: false,
        createdAt: conv1Time,
      },
      {
        clinicId: clinic.id,
        conversationId: conv1.id,
        whatsappAccountId: whatsappAccountId,
        direction: 'OUTBOUND',
        senderType: 'AI',
        senderName: 'AI Receptionist',
        content: 'Hello Pooja! Laser Teeth Whitening with Dr. Rajesh Sharma is ₹6,000 for a comprehensive 60-minute session. We have availability today at 10:30 AM or 3:30 PM. Would you like me to book a slot for you?',
        status: 'DELIVERED',
        isAiGenerated: true,
        createdAt: new Date(conv1Time.getTime() + 60000),
      },
      {
        clinicId: clinic.id,
        conversationId: conv1.id,
        whatsappAccountId: whatsappAccountId,
        direction: 'INBOUND',
        senderType: 'PATIENT',
        senderName: p1.name,
        content: 'Yes please, 10:30 AM works perfectly for me.',
        status: 'READ',
        isAiGenerated: false,
        createdAt: new Date(conv1Time.getTime() + 2 * 60000),
      },
      {
        clinicId: clinic.id,
        conversationId: conv1.id,
        whatsappAccountId: whatsappAccountId,
        direction: 'OUTBOUND',
        senderType: 'AI',
        senderName: 'AI Receptionist',
        content: 'Your appointment is confirmed with Dr. Rajesh Sharma for today at 10:30 AM. See you soon at Suite 402, Metro Health Plaza, Bandra West!',
        status: 'DELIVERED',
        isAiGenerated: true,
        createdAt: new Date(conv1Time.getTime() + 4 * 60000),
      },
    ],
  });

  // -------------------------------------------------------------------------
  // CONVERSATION 2: Rohit Singhania (HUMAN_ACTIVE - Dental Implant Consultation)
  // -------------------------------------------------------------------------
  const p2 = patients[1] || { name: 'Rohit Singhania', phone: '+91 98222 33445', id: undefined };
  const conv2Time = new Date(now.getTime() - 90 * 60000); // 1.5 hours ago

  const conv2 = await prisma.conversation.create({
    data: {
      clinicId: clinic.id,
      patientId: p2.id,
      doctorId: doctorId,
      assignedToUserId: staffId,
      whatsappAccountId: whatsappAccountId,
      participantName: p2.name,
      participantPhone: p2.phone,
      state: 'HUMAN_ACTIVE',
      unreadCount: 1,
      serviceInterested: 'German Dental Implant Placement',
      lastMessageText: 'I have checked with Dr. Rajesh Sharma regarding your BP medication; it is completely safe for the 3D CBCT scan today.',
      lastMessageAt: new Date(conv2Time.getTime() + 15 * 60000),
      lastActivityAt: new Date(conv2Time.getTime() + 15 * 60000),
      internalNotes: 'Patient has controlled hypertension. Staff Rahul took over to explain EMI financing and CBCT safety.',
    },
  });

  await prisma.message.createMany({
    data: [
      {
        clinicId: clinic.id,
        conversationId: conv2.id,
        whatsappAccountId: whatsappAccountId,
        direction: 'INBOUND',
        senderType: 'PATIENT',
        senderName: p2.name,
        content: 'Good morning, I lost an upper molar #26. Dr. Rajesh was recommended to me for German implants. Can you give me details?',
        status: 'READ',
        isAiGenerated: false,
        createdAt: conv2Time,
      },
      {
        clinicId: clinic.id,
        conversationId: conv2.id,
        whatsappAccountId: whatsappAccountId,
        direction: 'OUTBOUND',
        senderType: 'AI',
        senderName: 'AI Receptionist',
        content: 'Good morning Rohit! Dr. Rajesh Sharma specializes in German Titanium Dental Implants with over 14 years of surgical experience. The complete fixture and abutment package is ₹28,000. Would you like to schedule an initial 3D scan and assessment?',
        status: 'DELIVERED',
        isAiGenerated: true,
        createdAt: new Date(conv2Time.getTime() + 60000),
      },
      {
        clinicId: clinic.id,
        conversationId: conv2.id,
        whatsappAccountId: whatsappAccountId,
        direction: 'INBOUND',
        senderType: 'PATIENT',
        senderName: p2.name,
        content: 'I am on blood pressure medication. Is the implant surgical procedure safe for me? Also do you offer 0% EMI?',
        status: 'READ',
        isAiGenerated: false,
        createdAt: new Date(conv2Time.getTime() + 5 * 60000),
      },
      {
        clinicId: clinic.id,
        conversationId: conv2.id,
        whatsappAccountId: whatsappAccountId,
        direction: 'OUTBOUND',
        senderType: 'USER',
        senderName: 'Rahul Verma (Front Desk)',
        content: 'Hello Rohit, Rahul here from Apex Dental front desk! Yes, we offer 0% EMI options through Bajaj Finserv and major credit cards. I have checked with Dr. Rajesh Sharma regarding your BP medication; it is completely safe for the 3D CBCT scan today.',
        status: 'DELIVERED',
        isAiGenerated: false,
        createdAt: new Date(conv2Time.getTime() + 15 * 60000),
      },
    ],
  });

  // -------------------------------------------------------------------------
  // CONVERSATION 3: Vikram Joshi (HANDOFF_PENDING - Acute Tooth Pain Emergency)
  // -------------------------------------------------------------------------
  const p3 = patients[3] || { name: 'Vikram Joshi', phone: '+91 98444 55667', id: undefined };
  const conv3Time = new Date(now.getTime() - 10 * 60000); // 10 mins ago

  const conv3 = await prisma.conversation.create({
    data: {
      clinicId: clinic.id,
      patientId: p3.id,
      doctorId: doctorId,
      whatsappAccountId: whatsappAccountId,
      participantName: p3.name,
      participantPhone: p3.phone,
      state: 'HANDOFF_PENDING',
      unreadCount: 2,
      serviceInterested: 'Root Canal Treatment (Single Sitting)',
      handoffReason: 'Emergency Triage: Severe acute nocturnal tooth pain radiating to jaw',
      lastMessageText: 'I have flagged your severe pain to Dr. Rajesh Sharma and our front desk. An emergency coordinator is calling you immediately.',
      lastMessageAt: new Date(conv3Time.getTime() + 2 * 60000),
      lastActivityAt: new Date(conv3Time.getTime() + 2 * 60000),
      internalNotes: 'Urgent emergency triage triggered by AI keyword detection (severe throbbing pain). Requires immediate doctor review.',
    },
  });

  await prisma.message.createMany({
    data: [
      {
        clinicId: clinic.id,
        conversationId: conv3.id,
        whatsappAccountId: whatsappAccountId,
        direction: 'INBOUND',
        senderType: 'PATIENT',
        senderName: p3.name,
        content: 'URGENT: I have unbearable severe throbbing pain in my lower right molar since last night. Painkillers are not working and it is radiating to my ear. Can Dr. Rajesh see me right away?',
        status: 'READ',
        isAiGenerated: false,
        createdAt: conv3Time,
      },
      {
        clinicId: clinic.id,
        conversationId: conv3.id,
        whatsappAccountId: whatsappAccountId,
        direction: 'OUTBOUND',
        senderType: 'AI',
        senderName: 'AI Receptionist',
        content: 'Hello Vikram, I understand you are in severe pain. I have flagged your severe pain to Dr. Rajesh Sharma and our front desk. An emergency coordinator is calling you immediately on +91 98444 55667 for emergency relief and priority check-in.',
        status: 'DELIVERED',
        isAiGenerated: true,
        createdAt: new Date(conv3Time.getTime() + 2 * 60000),
      },
    ],
  });

  // -------------------------------------------------------------------------
  // CONVERSATION 4: Sneha Kulkarni (CLOSED - Clear Aligners Completed Followup)
  // -------------------------------------------------------------------------
  const p4 = patients[2] || { name: 'Sneha Kulkarni', phone: '+91 98333 44556', id: undefined };
  const conv4Time = new Date(now.getTime() - 24 * 3600000); // Yesterday

  const conv4 = await prisma.conversation.create({
    data: {
      clinicId: clinic.id,
      patientId: p4.id,
      doctorId: doctorId,
      whatsappAccountId: whatsappAccountId,
      participantName: p4.name,
      participantPhone: p4.phone,
      state: 'CLOSED',
      unreadCount: 0,
      serviceInterested: 'Clear Aligners Consultation & 3D Scan',
      lastMessageText: 'Thank you Sneha! Your 3D simulation video will be sent to your email by Dr. Rajesh tomorrow.',
      lastMessageAt: new Date(conv4Time.getTime() + 30 * 60000),
      lastActivityAt: new Date(conv4Time.getTime() + 30 * 60000),
    },
  });

  await prisma.message.createMany({
    data: [
      {
        clinicId: clinic.id,
        conversationId: conv4.id,
        whatsappAccountId: whatsappAccountId,
        direction: 'INBOUND',
        senderType: 'PATIENT',
        senderName: p4.name,
        content: 'Hello! I want to know about invisible clear aligners for mild crowding in my front teeth.',
        status: 'READ',
        isAiGenerated: false,
        createdAt: conv4Time,
      },
      {
        clinicId: clinic.id,
        conversationId: conv4.id,
        whatsappAccountId: whatsappAccountId,
        direction: 'OUTBOUND',
        senderType: 'AI',
        senderName: 'AI Receptionist',
        content: 'Hi Sneha! Dr. Rajesh Sharma provides state-of-the-art Clear Aligners with digital 3D iTero scanning. The scan consultation fee is ₹1,500.',
        status: 'READ',
        isAiGenerated: true,
        createdAt: new Date(conv4Time.getTime() + 5 * 60000),
      },
      {
        clinicId: clinic.id,
        conversationId: conv4.id,
        whatsappAccountId: whatsappAccountId,
        direction: 'INBOUND',
        senderType: 'PATIENT',
        senderName: p4.name,
        content: 'I visited yesterday and had my 3D scan done with Dr. Rajesh. When will I receive my smile treatment plan simulation?',
        status: 'READ',
        isAiGenerated: false,
        createdAt: new Date(conv4Time.getTime() + 25 * 60000),
      },
      {
        clinicId: clinic.id,
        conversationId: conv4.id,
        whatsappAccountId: whatsappAccountId,
        direction: 'OUTBOUND',
        senderType: 'USER',
        senderName: 'Rahul Verma (Front Desk)',
        content: 'Thank you Sneha! Your 3D simulation video will be sent to your email by Dr. Rajesh tomorrow. Have a great day!',
        status: 'READ',
        isAiGenerated: false,
        createdAt: new Date(conv4Time.getTime() + 30 * 60000),
      },
    ],
  });

  // -------------------------------------------------------------------------
  // CONVERSATION 5: Amit Patel (AI_ACTIVE - Lead Inquiring about Full Arch Implants)
  // -------------------------------------------------------------------------
  const lead1 = leads[0] || { name: 'Amit Patel', phone: '+91 98200 11223', id: undefined };
  const conv5Time = new Date(now.getTime() - 5 * 60000); // 5 mins ago

  const conv5 = await prisma.conversation.create({
    data: {
      clinicId: clinic.id,
      leadId: lead1.id,
      doctorId: doctorId,
      whatsappAccountId: whatsappAccountId,
      participantName: lead1.name,
      participantPhone: lead1.phone,
      state: 'AI_ACTIVE',
      unreadCount: 1,
      serviceInterested: 'German Dental Implant Placement',
      lastMessageText: 'Would you prefer a weekday evening consultation or Saturday morning with Dr. Rajesh Sharma?',
      lastMessageAt: new Date(conv5Time.getTime() + 2 * 60000),
      lastActivityAt: new Date(conv5Time.getTime() + 2 * 60000),
    },
  });

  await prisma.message.createMany({
    data: [
      {
        clinicId: clinic.id,
        conversationId: conv5.id,
        whatsappAccountId: whatsappAccountId,
        direction: 'INBOUND',
        senderType: 'PATIENT',
        senderName: lead1.name,
        content: 'Hello, looking for full upper arch dental implant replacement options for my father. Can we get a detailed quote?',
        status: 'READ',
        isAiGenerated: false,
        createdAt: conv5Time,
      },
      {
        clinicId: clinic.id,
        conversationId: conv5.id,
        whatsappAccountId: whatsappAccountId,
        direction: 'OUTBOUND',
        senderType: 'AI',
        senderName: 'AI Receptionist',
        content: 'Hello Amit! Dr. Rajesh Sharma offers All-on-4 and All-on-6 full arch rehabilitation with premium German implants. Dr. Rajesh will review the bone density and CBCT scans to provide a precise, itemized plan. Would you prefer a weekday evening consultation or Saturday morning with Dr. Rajesh Sharma?',
        status: 'DELIVERED',
        isAiGenerated: true,
        createdAt: new Date(conv5Time.getTime() + 2 * 60000),
      },
    ],
  });

  console.log('================================================================');
  console.log('🎉 Successfully Seeded 5 Realistic Conversations & Message Threads!');
  console.log('================================================================');
  console.log('1. Pooja Deshmukh    - AI Active (Whitening booked with Dr. Rajesh)');
  console.log('2. Rohit Singhania   - Human Active (Implant & EMI assistance by Staff)');
  console.log('3. Vikram Joshi      - Handoff Pending (Emergency acute pain triage)');
  console.log('4. Sneha Kulkarni    - Closed (Clear Aligners 3D scan completed)');
  console.log('5. Amit Patel (Lead) - AI Active (Full arch implant inquiry)');
  console.log('================================================================');
}

main()
  .catch((e) => {
    console.error('❌ Seeding Error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
