import crypto from "crypto";
import adminDb from "../config/firebase";
import logger from "../config/logger";
import { env } from "../config/env";

export interface OtpSession {
  phoneNumber: string;
  otpHash: string;
  type: string;
  createdAt: string;
  expiresAt: string;
  cooldownUntil: string;
  failedAttempts: number;
  verified: boolean;
}

export class WhatsAppOtpService {
  /**
   * Generates a cryptographically secure 6-digit OTP
   */
  private static generateOtp(): string {
    return crypto.randomInt(100000, 1000000).toString();
  }

  /**
   * Hashes the OTP using SHA-256
   */
  private static hashOtp(otp: string): string {
    return crypto.createHmac("sha256", env.OTP_HMAC_SECRET).update(otp).digest("hex");
  }

  private static hashesEqual(left: string, right: string): boolean {
    if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
    const leftBuffer = Buffer.from(left, "hex");
    const rightBuffer = Buffer.from(right, "hex");
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
  }

  /**
   * Resolves the canonical API key for a WhatsApp instance by querying the WhatsAPI gateway
   * using admin credentials if necessary.
   */
  private static async resolveGatewayInstanceKey(
    apiUrl: string,
    targetInstanceId: string,
    fallbackApiKey: string,
    adminUsername?: string,
    adminPassword?: string
  ): Promise<{ resolvedApiKey: string; sessionCookie?: string }> {
    if (!apiUrl) return { resolvedApiKey: fallbackApiKey };

    try {
      const urlObj = new URL(apiUrl);
      const baseUrl = `${urlObj.protocol}//${urlObj.host}`;

      if (!adminUsername || !adminPassword) {
        return { resolvedApiKey: fallbackApiKey };
      }

      // 1. Authenticate with WhatsAPI Admin Session
      const loginEndpoints = [`${baseUrl}/api/login`, `${baseUrl}/login`, `${baseUrl}/api/auth/login`];
      let sessionCookie = "";

      for (const ep of loginEndpoints) {
        try {
          const loginRes = await fetch(ep, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              username: adminUsername,
              password: adminPassword,
            }),
          });

          if (loginRes.ok) {
            const setCookieHeader = loginRes.headers.get("set-cookie");
            if (setCookieHeader) {
              sessionCookie = setCookieHeader.split(";")[0];
              logger.info(`[WhatsAppOtpService] Successfully logged in as admin to WhatsAPI gateway at ${ep}`);
              break;
            }
          }
        } catch {}
      }

      if (!sessionCookie) {
        logger.warn(`[WhatsAppOtpService] Could not establish admin session on WhatsAPI gateway.`);
        return { resolvedApiKey: fallbackApiKey };
      }

      // 2. Query list of WhatsApp instances to retrieve the matching instance's actual API key
      const instRes = await fetch(`${baseUrl}/api/instances`, {
        headers: { Cookie: sessionCookie },
      });

      if (instRes.ok) {
        const instList: any = await instRes.json().catch(() => []);
        if (Array.isArray(instList) && instList.length > 0) {
          // Find matching instance by ID or name, or fallback to the first active connected instance
          let matchedInst = instList.find(
            (i: any) => i.id === targetInstanceId || i.name === targetInstanceId
          );

          if (!matchedInst) {
            matchedInst = instList.find((i: any) => i.status === "connected") || instList[0];
          }

          if (matchedInst && matchedInst.apiKey) {
            logger.info(`[WhatsAppOtpService] Resolved real gateway API key for instance '${matchedInst.id}': ${matchedInst.apiKey.slice(0, 8)}...`);
            return { resolvedApiKey: matchedInst.apiKey, sessionCookie };
          }
        }
      }

      // 3. If instance not found or needs registration with fallbackApiKey, start/create instance
      try {
        const startRes = await fetch(`${baseUrl}/api/instances`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: sessionCookie,
          },
          body: JSON.stringify({
            id: targetInstanceId,
            name: targetInstanceId,
            apiKey: fallbackApiKey,
          }),
        });

        if (startRes.ok) {
          const startData: any = await startRes.json().catch(() => ({}));
          const key = startData?.instance?.apiKey || fallbackApiKey;
          logger.info(`[WhatsAppOtpService] Created/Started instance '${targetInstanceId}' on WhatsAPI gateway.`);
          return { resolvedApiKey: key, sessionCookie };
        }
      } catch (startErr: any) {
        logger.warn(`[WhatsAppOtpService] Could not auto-create instance on gateway: ${startErr.message}`);
      }

      return { resolvedApiKey: fallbackApiKey, sessionCookie };
    } catch (err: any) {
      logger.warn(`[WhatsAppOtpService] Exception resolving instance key on gateway: ${err.message}`);
      return { resolvedApiKey: fallbackApiKey };
    }
  }

  /**
   * Clean up expired OTP sessions from Firestore
   */
  public static async cleanupExpiredOtps(): Promise<void> {
    try {
      if (!adminDb) return;
      const now = new Date().toISOString();
      const expiredSnap = await adminDb
        .collection("otp_sessions")
        .where("expiresAt", "<", now)
        .get();

      if (expiredSnap.empty) return;

      const batch = adminDb.batch();
      expiredSnap.docs.forEach((doc) => {
        batch.delete(doc.ref);
      });
      await batch.commit();
      logger.info(`[WhatsAppOtpService] Cleaned up ${expiredSnap.size} expired OTP sessions.`);
    } catch (err: any) {
      logger.error(`[WhatsAppOtpService] Failed to cleanup expired OTPs: ${err.message}`);
    }
  }

  /**
   * Sends OTP via external WhatsApp gateway
   */
  public static async sendOtp(phoneNumber: string, type: string = "signup"): Promise<{ message: string }> {
    const isProd = env.NODE_ENV === "production";

    let whatsappApiUrl = env.WHATSAPP_API_URL;
    let whatsappApiKey = env.WHATSAPP_API_KEY;
    let whatsappInstanceId = env.WHATSAPP_INSTANCE_ID;
    let whatsappAdminUsername = env.WHATSAPP_ADMIN_USERNAME;
    let whatsappAdminPassword = env.WHATSAPP_ADMIN_PASSWORD;

    // Dynamically check Firestore config if available
    try {
      if (adminDb) {
        const waDoc = await adminDb.collection("config").doc("whatsapp_api").get();
        if (waDoc.exists) {
          const waData = waDoc.data();
          if (waData?.whatsappApiUrl) whatsappApiUrl = waData.whatsappApiUrl;
          if (waData?.whatsappApiKey) whatsappApiKey = waData.whatsappApiKey;
          if (waData?.whatsappInstanceId) whatsappInstanceId = waData.whatsappInstanceId;
          if (waData?.whatsappAdminUsername) whatsappAdminUsername = waData.whatsappAdminUsername;
          if (waData?.whatsappAdminPassword) whatsappAdminPassword = waData.whatsappAdminPassword;
        } else {
          const emailDoc = await adminDb.collection("config").doc("email_connect").get();
          if (emailDoc.exists) {
            const emailData = emailDoc.data();
            if (emailData?.whatsappApiUrl || emailData?.emailApiUrl) {
              whatsappApiUrl = emailData.whatsappApiUrl || emailData.emailApiUrl;
            }
            if (emailData?.whatsappApiKey || emailData?.emailApiKey) {
              whatsappApiKey = emailData.whatsappApiKey || emailData.emailApiKey;
            }
            if (emailData?.whatsappInstanceId || emailData?.emailInstanceId) {
              whatsappInstanceId = emailData.whatsappInstanceId || emailData.emailInstanceId;
            }
            if (emailData?.emailAdminUsername) whatsappAdminUsername = emailData.emailAdminUsername;
            if (emailData?.emailAdminPassword) whatsappAdminPassword = emailData.emailAdminPassword;
          }
        }
      }
    } catch (dbErr: any) {
      logger.warn(`[WhatsAppOtpService] Dynamic config fetch warning: ${dbErr.message}`);
    }

    // Validate configuration
    if (!whatsappApiUrl || !whatsappInstanceId) {
      const configError = "Configuration Error: Missing WHATSAPP_API_URL or WHATSAPP_INSTANCE_ID.";
      if (!isProd) {
        logger.warn(`[WhatsAppOtpService] ${configError} (Development Mode fallback enabled)`);
      } else {
        logger.error(`[WhatsAppOtpService] ${configError}`);
        throw new Error("WhatsApp Service configuration is incomplete. Please contact support.");
      }
    }

    if (!adminDb) {
      throw new Error("Firestore Admin Database not initialized.");
    }

    // Standardize phone format (e.g., must be digits-only, no leading + or spaces)
    const cleanPhone = phoneNumber.replace(/\D/g, "");

    // 1. Check existing session for rate limits and cooldowns
    const sessionDocRef = adminDb.collection("otp_sessions").doc(cleanPhone);
    const sessionSnap = await sessionDocRef.get();
    const now = new Date();

    if (sessionSnap.exists) {
      const data = sessionSnap.data() as OtpSession;
      const cooldownTime = new Date(data.cooldownUntil);
      if (now < cooldownTime) {
        const waitSec = Math.ceil((cooldownTime.getTime() - now.getTime()) / 1000);
        throw new Error(`Rate limit exceeded. Please wait ${waitSec}s before requesting a new OTP.`);
      }
    }

    // 2. Generate new OTP
    const rawOtp = this.generateOtp();
    const otpHash = this.hashOtp(rawOtp);

    // 3. Build templates/cooldown timelines
    const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString(); // 10 minutes expiry
    const cooldownUntil = new Date(now.getTime() + 60 * 1000).toISOString(); // 60 seconds cooldown

    // Selected random message templates to secure against automated pattern detection and spam filtering
    const messageTemplates = [
      `Your 9iceMoney Access OTP verification code is: *${rawOtp}*. It expires in 10 minutes. Do not share this code with anyone.`,
      `Security Alert: Use *${rawOtp}* to verify your 9iceMoney account phone number. This OTP is valid for 10 minutes.`,
      `Your secure one-time passcode is *${rawOtp}* for 9iceMoney registration. Please enter this code to complete verification.`
    ];
    const messageText = messageTemplates[crypto.randomInt(0, messageTemplates.length)];

    // 4. Send Message via WhatsApp Gateway S2S HTTP request
    let sendSuccess = false;
    let apiErrorMsg = "";

    if (whatsappApiUrl && whatsappInstanceId) {
      try {
        // Construct canonical target URL endpoint: ensure it points to /api/send/text
        let targetUrl = whatsappApiUrl.trim().replace(/\/+$/, "");
        targetUrl = targetUrl.replace("whatsapp-5fda.onrender.com", "whatsapp-b5os.onrender.com");

        if (!targetUrl.includes("/api/send/text") && !targetUrl.includes("/send/text")) {
          if (targetUrl.endsWith("/api")) {
            targetUrl = `${targetUrl}/send/text`;
          } else {
            targetUrl = `${targetUrl}/api/send/text`;
          }
        }

        const payload = {
          number: cleanPhone,
          message: messageText,
        };

        const dispatchReq = async (apiKeyToUse: string, cookieToUse?: string) => {
          // Strictly send single Header keys to avoid Header duplication merging in fetch
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "X-API-Key": apiKeyToUse.trim(),
            "X-Instance-ID": whatsappInstanceId.trim(),
          };
          if (cookieToUse) headers["Cookie"] = cookieToUse;

          return await fetch(targetUrl, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
          });
        };

        logger.info(`[WhatsAppOtpService] Dispatching OTP message to WhatsApp gateway endpoint: ${targetUrl} | phone=${cleanPhone}`);

        let res = await dispatchReq(whatsappApiKey);

        if (res.ok) {
          sendSuccess = true;
          logger.info(`[WhatsAppOtpService] OTP successfully sent via WhatsApp API.`);
        } else {
          let textResponse = await res.text();
          apiErrorMsg = `Gateway responded with status ${res.status}: ${textResponse}`;
          logger.error(`[WhatsAppOtpService] WhatsApp API initial attempt failed: ${apiErrorMsg}`);

          // If 401 or 403 Forbidden / Invalid API Key occurs, query the gateway using admin login to resolve the real instance key
          if (res.status === 401 || res.status === 403 || textResponse.includes("Forbidden") || textResponse.includes("Invalid API Key") || textResponse.includes("Unauthorized")) {
            logger.info(`[WhatsAppOtpService] 401/403 detected. Resolving actual gateway instance key via admin session...`);
            const { resolvedApiKey, sessionCookie } = await this.resolveGatewayInstanceKey(
              whatsappApiUrl,
              whatsappInstanceId,
              whatsappApiKey,
              whatsappAdminUsername,
              whatsappAdminPassword
            );

            if (resolvedApiKey) {
              logger.info(`[WhatsAppOtpService] Retrying WhatsApp dispatch with resolved API key...`);
              const retryRes = await dispatchReq(resolvedApiKey, sessionCookie);
              if (retryRes.ok) {
                sendSuccess = true;
                logger.info(`[WhatsAppOtpService] OTP successfully sent after resolving real instance API key!`);

                // Persist the resolved key to Firestore config so future dispatches succeed immediately
                if (adminDb && resolvedApiKey !== whatsappApiKey) {
                  try {
                    await adminDb.collection("config").doc("whatsapp_api").set(
                      { whatsappApiKey: resolvedApiKey, updatedAt: new Date().toISOString() },
                      { merge: true }
                    );
                    logger.info(`[WhatsAppOtpService] Updated Firestore config/whatsapp_api with working API key.`);
                  } catch {}
                }
              } else {
                const retryText = await retryRes.text();
                logger.error(`[WhatsAppOtpService] Retry with resolved API key failed: ${retryRes.status} ${retryText}`);
                apiErrorMsg = `Gateway responded with status ${retryRes.status}: ${retryText}`;
              }
            }
          }
        }
      } catch (err: any) {
        apiErrorMsg = err.message;
        logger.error(`[WhatsAppOtpService] Connection to WhatsApp gateway failed: ${apiErrorMsg}`);
      }
    }

    // If in production and API dispatch failed, we raise a server error
    if (isProd && !sendSuccess) {
      throw new Error(`WhatsApp Dispatch Failed: ${apiErrorMsg || "No response from gateway"}`);
    }

    // 5. Update/Save Session in Firestore securely
    const newSession: OtpSession = {
      phoneNumber: cleanPhone,
      otpHash,
      type,
      createdAt: now.toISOString(),
      expiresAt,
      cooldownUntil,
      failedAttempts: 0,
      verified: false,
    };

    await sessionDocRef.set(newSession);

    // Audit Log Entry
    await adminDb.collection("otp_audits").add({
      phoneNumber: cleanPhone,
      type,
      action: "GENERATE",
      status: "SUCCESS",
      timestamp: now.toISOString(),
    });

    return {
      message: "OTP sent successfully via WhatsApp.",
    };
  }

  /**
   * Verifies the OTP code
   */
  public static async verifyOtp(phoneNumber: string, otpCode: string, type: string = "signup"): Promise<{ success: boolean; message: string }> {
    if (!adminDb) {
      throw new Error("Firestore Admin Database not initialized.");
    }

    const cleanPhone = phoneNumber.replace(/\D/g, "");
    const sessionDocRef = adminDb.collection("otp_sessions").doc(cleanPhone);
    const verification = await adminDb.runTransaction(async (transaction) => {
      const sessionSnap = await transaction.get(sessionDocRef);
      if (!sessionSnap.exists) {
        return { success: false as const, error: "No active verification session found. Please request a new OTP." };
      }

      const data = sessionSnap.data() as OtpSession;
      if (data.type !== type) {
        return { success: false as const, error: "Verification code does not match the requested verification purpose." };
      }

      if (data.verified === true) {
        return { success: true as const, message: "WhatsApp number was already verified." };
      }

      const now = new Date();
      if (!data.expiresAt || now > new Date(data.expiresAt)) {
        transaction.delete(sessionDocRef);
        return { success: false as const, error: "Verification code has expired. Please request a new OTP." };
      }

      const attempts = Number(data.failedAttempts) || 0;
      if (attempts >= 3) {
        transaction.delete(sessionDocRef);
        return { success: false as const, error: "Too many failed attempts. This verification session has been terminated. Please generate a new OTP." };
      }

      const hashedProvided = this.hashOtp(otpCode.trim());
      if (!this.hashesEqual(hashedProvided, data.otpHash)) {
        const nextAttempts = attempts + 1;
        if (nextAttempts >= 3) {
          transaction.delete(sessionDocRef);
          return { success: false as const, error: "Too many failed attempts. This verification session has been terminated. Please generate a new OTP." };
        }

        transaction.update(sessionDocRef, { failedAttempts: nextAttempts });
        return {
          success: false as const,
          error: `Incorrect verification code. You have ${3 - nextAttempts} attempts remaining before lockout.`,
        };
      }

      transaction.update(sessionDocRef, {
        verified: true,
        expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
      });
      return { success: true as const, message: "WhatsApp OTP verified successfully." };
    });

    await adminDb.collection("otp_audits").add({
      phoneNumber: cleanPhone,
      type,
      action: verification.success ? "VERIFY_SUCCESS" : "VERIFY_ATTEMPT",
      status: verification.success ? "SUCCESS" : "FAILED",
      timestamp: new Date().toISOString(),
    });

    if (!verification.success) throw new Error(verification.error);
    return {
      success: true,
      message: verification.message,
    };
  }

  /**
   * Sends an already-generated security OTP using only backend VM WhatsApp env.
   * This is used by application-managed 2FA and new-device challenges.
   */
  public static async sendRawOtp(phoneNumber: string, otp: string, purpose: string): Promise<void> {
    const code = String(otp || "").trim();
    const cleanPhone = String(phoneNumber || "").replace(/\D/g, "");
    if (!/^[0-9]{6}$/.test(code)) throw new Error("A valid 6-digit OTP is required.");
    if (cleanPhone.length < 8) throw new Error("A valid WhatsApp destination is required.");
    const apiUrl = env.WHATSAPP_API_URL;
    const apiKey = env.WHATSAPP_API_KEY;
    const instanceId = env.WHATSAPP_INSTANCE_ID;
    if (!apiUrl || !apiKey || !instanceId) {
      throw new Error("VM WhatsApp service is not configured. Please contact support.");
    }

    let targetUrl = apiUrl.trim().replace(/\/+$/, "");
    if (!targetUrl.includes("/api/send/text") && !targetUrl.includes("/send/text")) {
      targetUrl = targetUrl.endsWith("/api") ? `${targetUrl}/send/text` : `${targetUrl}/api/send/text`;
    }

    const label = purpose === "new_device_login" ? "New Device Security Login" : "2FA Login Authentication";
    const message = `Your 9iceMoney ${label} Verification Code is *${code}*. Valid for 5 minutes. Do not share with anyone.`;
    const response = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey.trim(),
        "X-Instance-ID": instanceId.trim(),
      },
      body: JSON.stringify({ number: cleanPhone, message }),
    });
    if (!response.ok) {
      const textResponse = await response.text().catch(() => "");
      logger.error(`[WhatsAppOtpService] Security OTP delivery failed: HTTP ${response.status} ${textResponse.slice(0, 300)}`);
      throw new Error("Failed to deliver WhatsApp verification code. Please try again later.");
    }
  }
}
