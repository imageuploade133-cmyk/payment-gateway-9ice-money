/**
 * 9PSB integration boundary.
 *
 * WAAS/VAS credentials and endpoints must be supplied through server-side secrets.
 * The sandbox URLs previously supplied use plain HTTP and must never be used to
 * transmit credentials or financial/customer data over an untrusted network.
 *
 * The currently available information does not define request/response schemas,
 * transfer notification verification, or VAS status/reversal contracts. Therefore
 * this adapter intentionally fails closed until the official secure contract is
 * configured and implemented. Do not add guessed endpoint paths or payloads here.
 */
export type NinePsbServiceArea = "WAAS" | "VAS";

export class NinePsbService {
  private static secureBaseUrl(value: string | undefined): string | null {
    const candidate = String(value || "").trim();
    if (!candidate) return null;
    try {
      const parsed = new URL(candidate);
      return parsed.protocol === "https:" ? parsed.origin : null;
    } catch {
      return null;
    }
  }

  public static getReadiness(): {
    enabled: boolean;
    waasReady: boolean;
    vasReady: boolean;
    reason?: string;
  } {
    const enabled = String(process.env.NINEPSB_ENABLED || "").toLowerCase() === "true";
    const waasBase = this.secureBaseUrl(process.env.NINEPSB_WAAS_BASE_URL);
    const vasBase = this.secureBaseUrl(process.env.NINEPSB_VAS_BASE_URL);
    const waasCredentials = !!(
      process.env.NINEPSB_WAAS_USERNAME &&
      process.env.NINEPSB_WAAS_PASSWORD &&
      process.env.NINEPSB_WAAS_CLIENT_ID &&
      process.env.NINEPSB_WAAS_CLIENT_SECRET
    );
    const vasCredentials = !!(
      process.env.NINEPSB_VAS_USERNAME &&
      process.env.NINEPSB_VAS_PASSWORD
    );
    const waasReady = enabled && !!waasBase && waasCredentials;
    const vasReady = enabled && !!vasBase && vasCredentials;

    return {
      enabled,
      waasReady,
      vasReady,
      ...(!waasReady || !vasReady
        ? { reason: "9PSB is disabled until secure HTTPS endpoints, server-side credentials, and the official API contract are configured." }
        : { reason: "Secure connection configuration is present; API contract implementation and certification are still required before enabling transactions." }),
    };
  }

  public static assertContractReady(area: NinePsbServiceArea): never {
    const readiness = this.getReadiness();
    const ready = area === "WAAS" ? readiness.waasReady : readiness.vasReady;
    if (!ready) {
      throw new Error(`9PSB ${area} is unavailable: ${readiness.reason}`);
    }
    // Deliberately fail closed: secure URLs and credentials alone do not define
    // the provider's API contract, transfer verification, or financial lifecycle.
    throw new Error(`9PSB ${area} API contract has not yet been implemented and certified.`);
  }
}
