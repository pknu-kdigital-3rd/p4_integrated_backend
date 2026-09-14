import { z } from "zod";

export const bigintIdSchema = z
    .string()
    .regex(/^[1-9]\d*$/);

export const decimalSchema = z
    .string()
    .regex(/^-?\d+(\.\d+)?$/);

export const dateTimeSchema = z
    .iso
    .datetime();

export const apiErrorSchema = z.object({
    error: z.object({
        code: z.string(),
        message: z.string(),
    }),
});