/**
 * CivicShield AI — synthetic worker registry (Phase 2A).
 *
 * DETERMINISTIC + SYNTHETIC ONLY. Every record is clearly fictional
 * (employee IDs are prefixed "DEMO-", names are generic roles, no real
 * personal data). The registry exists so Phase 2B/2C automatic assignment
 * can be tested realistically: it covers every department, diverse skill
 * sets, equipment capabilities, availability states, and service areas.
 *
 * Re-running the seed is idempotent: upserts are keyed on the unique
 * employeeId (profile) / email (user), never counted.
 */

export type SyntheticWorker = {
  email: string;
  name: string;
  employeeId: string;
  departmentCode: string;
  designation: string;
  skills: string[];
  equipment: string[];
  availability: "AVAILABLE" | "OFF_DUTY" | "SUSPENDED";
  serviceAreas: string[];
  base: { lat: number; lng: number } | null;
  maxActiveAssignments: number;
  phone: string;
};

export const SYNTHETIC_WORKERS: SyntheticWorker[] = [
  {
    email: "worker.pwd.roads@civicshield.demo",
    name: "Demo Worker — Road Crew A",
    employeeId: "DEMO-PWD-001",
    departmentCode: "PWD",
    designation: "Road Repair Crew Lead",
    skills: ["ROAD_REPAIR", "ASPHALT_LAYING"],
    equipment: ["JCB_EXCAVATOR", "ROAD_ROLLER", "DRILL"],
    availability: "AVAILABLE",
    serviceAreas: ["Ward 1", "Ward 2", "Ward 5"],
    base: { lat: 16.6952, lng: 74.4574 },
    maxActiveAssignments: 4,
    phone: "9000000101",
  },
  {
    email: "worker.pwd.roads2@civicshield.demo",
    name: "Demo Worker — Road Crew B",
    employeeId: "DEMO-PWD-002",
    departmentCode: "PWD",
    designation: "Road Repair Technician",
    skills: ["ROAD_REPAIR"],
    equipment: ["DRILL"],
    availability: "AVAILABLE",
    serviceAreas: ["Ward 3", "Ward 4"],
    base: { lat: 16.7021, lng: 74.4589 },
    maxActiveAssignments: 3,
    phone: "9000000102",
  },
  {
    email: "worker.swm.collection@civicshield.demo",
    name: "Demo Worker — Sanitation A",
    employeeId: "DEMO-SWM-001",
    departmentCode: "SWM",
    designation: "Sanitation Supervisor",
    skills: ["WASTE_COLLECTION", "WASTE_SORTING", "SANITATION_INSPECTION"],
    equipment: ["COMPACTOR_TRUCK", "DUMPER"],
    availability: "AVAILABLE",
    serviceAreas: ["Ward 1", "Ward 3", "Ward 4"],
    base: { lat: 16.6989, lng: 74.4523 },
    maxActiveAssignments: 5,
    phone: "9000000103",
  },
  {
    email: "worker.swm.hazmat@civicshield.demo",
    name: "Demo Worker — Sanitation B",
    employeeId: "DEMO-SWM-002",
    departmentCode: "SWM",
    designation: "Waste Handler",
    skills: ["WASTE_COLLECTION", "HAZMAT_HANDLING"],
    equipment: ["DUMPER", "SAFETY_HARNESS"],
    availability: "OFF_DUTY",
    serviceAreas: ["Ward 2", "Ward 7"],
    base: { lat: 16.6911, lng: 74.461 },
    maxActiveAssignments: 3,
    phone: "9000000104",
  },
  {
    email: "worker.elect.lights@civicshield.demo",
    name: "Demo Worker — Electrical A",
    employeeId: "DEMO-ELECT-001",
    departmentCode: "ELECT",
    designation: "Streetlight Technician",
    skills: ["ELECTRICAL_REPAIR", "STREETLIGHT_MAINTENANCE"],
    equipment: ["POLE_TRUCK", "GENERATOR", "SAFETY_HARNESS"],
    availability: "AVAILABLE",
    serviceAreas: ["Ward 5", "Ward 6", "Ward 7"],
    base: { lat: 16.694, lng: 74.4531 },
    maxActiveAssignments: 3,
    phone: "9000000105",
  },
  {
    email: "worker.water.drainage@civicshield.demo",
    name: "Demo Worker — Drainage A",
    employeeId: "DEMO-WATER-001",
    departmentCode: "WATER",
    designation: "Drainage Operator",
    skills: ["DRAINAGE_CLEARING", "WATER_PUMP_OPERATION", "PLUMBING"],
    equipment: ["WATER_PUMP", "CHAINSAW"],
    availability: "AVAILABLE",
    serviceAreas: ["Ward 2", "Ward 3", "Ward 6"],
    base: { lat: 16.7021, lng: 74.4589 },
    maxActiveAssignments: 4,
    phone: "9000000106",
  },
  {
    email: "worker.health.sanitation@civicshield.demo",
    name: "Demo Worker — Health Inspector",
    employeeId: "DEMO-HEALTH-001",
    departmentCode: "HEALTH",
    designation: "Sanitation Inspector",
    skills: ["SANITATION_INSPECTION", "PEST_CONTROL"],
    equipment: [],
    availability: "AVAILABLE",
    serviceAreas: ["Ward 1", "Ward 4", "Ward 7"],
    base: { lat: 16.6875, lng: 74.4498 },
    maxActiveAssignments: 6,
    phone: "9000000107",
  },
  {
    email: "worker.gen.general@civicshield.demo",
    name: "Demo Worker — General Duty",
    employeeId: "DEMO-GEN-001",
    departmentCode: "GEN",
    designation: "General Maintenance",
    skills: ["ROAD_REPAIR", "WASTE_COLLECTION"],
    equipment: ["DRILL"],
    availability: "SUSPENDED",
    serviceAreas: ["Ward 6"],
    base: null,
    maxActiveAssignments: 2,
    phone: "9000000108",
  },
];

/**
 * Upsert the synthetic registry. Idempotent; safe to run repeatedly.
 * Requires departments to exist (run after the department upserts in seed.ts).
 */
export async function upsertSyntheticWorkers(
  prisma: import("@prisma/client").PrismaClient
): Promise<void> {
  for (const w of SYNTHETIC_WORKERS) {
    const department = await prisma.department.findUnique({ where: { code: w.departmentCode } });
    if (!department) throw new Error(`Registry seed: missing department ${w.departmentCode}`);

    // Legacy seeded workers may already exist (worker@civicshield.demo etc.);
    // the registry only manages its own synthetic rows.
    const user = await prisma.user.upsert({
      where: { email: w.email },
      update: {},
      create: {
        email: w.email,
        name: w.name,
        role: "WORKER",
        phone: w.phone,
        departmentId: department.id,
        // Unusable random hash — these rows are staff assignment targets only.
        // Real people claim them via STAFF_EMAILS Google sign-in.
        passwordHash: `!disabled:${crypto.randomUUID()}`,
      },
    });

    await prisma.workerProfile.upsert({
      where: { employeeId: w.employeeId },
      update: {
        departmentId: department.id,
        skills: w.skills,
        equipment: w.equipment,
        availability: w.availability,
        serviceAreas: w.serviceAreas,
        designation: w.designation,
        baseLat: w.base?.lat,
        baseLng: w.base?.lng,
        maxActiveAssignments: w.maxActiveAssignments,
      },
      create: {
        userId: user.id,
        employeeId: w.employeeId,
        departmentId: department.id,
        skills: w.skills,
        equipment: w.equipment,
        availability: w.availability,
        serviceAreas: w.serviceAreas,
        designation: w.designation,
        baseLat: w.base?.lat,
        baseLng: w.base?.lng,
        maxActiveAssignments: w.maxActiveAssignments,
        phone: w.phone,
        approvedById: user.id, // self-seeded synthetic verification (registry, not a real review)
      },
    });
  }
}
