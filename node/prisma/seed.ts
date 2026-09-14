import { hashPassword } from "../src/common/auth/password";
import { prisma } from "../src/infrastructure/database/prisma";


async function main() {
    const passwordHash = await hashPassword(
        "admin1234",
    );

    await prisma.platformAccount.upsert({
        where: {
            loginId: "admin",
        },
        update: {},
        create: {
            loginId: "admin",
            passwordHash,
            userName: "Administrator",
            role: "ADMIN",
            isActive: true,
        },
    });

    console.log("Development admin user seeded");

    for (const vehicle of [
        { vehicleCode: "CUSTOM-TRUCK-01", vehicleName: "Custom Truck 1", heightM: "3.8", widthM: "2.5", lengthM: "12.0", maxLoadKg: "12000" },
        { vehicleCode: "CUSTOM-TRUCK-02", vehicleName: "Custom Truck 2", heightM: "3.2", widthM: "2.3", lengthM: "8.0", maxLoadKg: "7000" },
    ]) {
        await prisma.vehicle.upsert({
            where: { vehicleCode: vehicle.vehicleCode },
            update: {},
            create: { ...vehicle, vehicleSource: "CUSTOM", vehicleStatus: "READY" },
        });
    }

    console.log("Integrated demo vehicles seeded");
}

try {
    await main();
} finally {
    await prisma.$disconnect();
}
