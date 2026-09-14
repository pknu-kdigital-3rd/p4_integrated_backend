import { prisma } from "../../infrastructure/database/prisma.ts";

export const authoRepository = {
    async findByLoginId(loginId: string) {
        return prisma.platformAccount.findUnique({
            where: {
                loginId,
            },
        });
    },
};
