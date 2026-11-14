import { Request, Response } from "express";
import { z } from "zod";
import { PaystackInitializationService } from "../services/paystackInitializationService";

const initializeSchema = z.object({
  amount: z.number().finite().positive().max(100000000),
  currency: z.string().trim().length(3).default("NGN"),
  email: z.string().trim().email().max(254),
  reference: z.string().trim().min(8).max(100).regex(/^[A-Za-z0-9._-]+$/, "Reference contains unsupported characters."),
  callback_url: z.string().url().max(2048).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export async function initializePaystackPayment(req: Request, res: Response): Promise<void> {
  const parsed = initializeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      message: "Invalid Paystack initialization request.",
      errors: parsed.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    });
    return;
  }

  const result = await PaystackInitializationService.initialize({
    amount: parsed.data.amount,
    currency: parsed.data.currency,
    email: parsed.data.email,
    reference: parsed.data.reference,
    callbackUrl: parsed.data.callback_url,
    metadata: parsed.data.metadata,
  });

  res.status(result.success ? 200 : result.message?.includes("not configured") ? 503 : 502).json(result);
}
