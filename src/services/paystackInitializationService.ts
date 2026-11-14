import { env } from "../config/env";
import logger from "../config/logger";
import { getPaystackClient } from "../providers/paystack";

export interface InitializePaystackPaymentParams {
  amount: number;
  currency: string;
  email: string;
  reference: string;
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface InitializePaystackPaymentResult {
  success: boolean;
  reference: string;
  authorizationUrl?: string;
  accessCode?: string;
  message?: string;
}

/**
 * Creates a Paystack hosted checkout session.
 *
 * This deliberately does not credit a wallet. Wallet crediting remains disabled
 * until Paystack verification/webhook events are connected to the shared,
 * provider-neutral ledger-credit transaction.
 */
export class PaystackInitializationService {
  static async initialize(params: InitializePaystackPaymentParams): Promise<InitializePaystackPaymentResult> {
    const reference = params.reference.trim();

    // Never allow the mock development fallback keys in the provider factory to
    // make a real checkout appear successful.
    if (!env.PAYSTACK_SECRET_KEY || env.PAYSTACK_SECRET_KEY.includes("mock")) {
      return {
        success: false,
        reference,
        message: "Paystack is not configured. Add valid PAYSTACK_SECRET_KEY credentials on the gateway server.",
      };
    }

    if (!Number.isFinite(params.amount) || params.amount <= 0) {
      return { success: false, reference, message: "Amount must be greater than zero." };
    }

    const amountInMinorUnits = Math.round(params.amount * 100);
    if (!Number.isSafeInteger(amountInMinorUnits) || amountInMinorUnits <= 0) {
      return { success: false, reference, message: "Amount is outside the supported range." };
    }

    try {
      const client = getPaystackClient();
      const payload: Record<string, unknown> = {
        email: params.email.trim(),
        amount: amountInMinorUnits,
        currency: params.currency.trim().toUpperCase(),
        reference,
      };

      if (params.callbackUrl) payload.callback_url = params.callbackUrl;
      if (params.metadata) payload.metadata = params.metadata;

      const response = await client.request("post", "/transaction/initialize", payload);
      const data = response?.data;

      if (response?.status === true && data?.authorization_url && data?.reference) {
        return {
          success: true,
          reference: String(data.reference),
          authorizationUrl: String(data.authorization_url),
          accessCode: data.access_code ? String(data.access_code) : undefined,
          message: response.message || "Paystack checkout initialized.",
        };
      }

      logger.warn(`[PaystackInitializationService] Unexpected initialization response | reference=${reference}`);
      return {
        success: false,
        reference,
        message: response?.message || "Paystack did not return a valid checkout authorization URL.",
      };
    } catch (error: any) {
      logger.error(`[PaystackInitializationService] Initialization failed | reference=${reference} | error=${error.message}`);
      return {
        success: false,
        reference,
        message: "Unable to initialize Paystack checkout. Please try again or contact support.",
      };
    }
  }
}
