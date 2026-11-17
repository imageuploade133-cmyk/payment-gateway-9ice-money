# 9PSB WAAS + VAS integration readiness

9PSB is represented as a provider boundary, but live requests are intentionally not implemented yet.

## Available information
- WAAS authentication endpoint and open-wallet endpoint were supplied for a test environment.
- VAS authentication endpoint and service test identifiers were supplied.
- Both supplied base URLs use plain HTTP.

## Required before implementation
Obtain the official, current API specification or Postman collection covering:
1. WAAS authentication request/response, token type, expiry and refresh behavior.
2. Open-wallet request schema, required identity fields, idempotency support and response schema.
3. Account enquiry and incoming-transfer notification mechanism.
4. Cryptographic webhook verification, replay protection and transfer verification/enquiry.
5. VAS service catalogue, product codes, request schemas and response schemas.
6. Transaction status enquiry, timeout handling, reversal/refund and reconciliation contracts.
7. Secure HTTPS sandbox and production endpoints, IP allowlisting and TLS requirements.

## Security
- Do not commit credentials or put them in frontend environment variables.
- Rotate any credentials shared in chat or other plaintext channels.
- Do not send credentials, identity data or financial data to the supplied HTTP endpoints over an untrusted network.
- Configure future credentials only as server-side secrets.
- NINEPSB_ENABLED must remain false until the provider contract is implemented, tested and certified.
- Use separate WAAS and VAS base URL and credential sets.

## Server-side environment variable names reserved for the adapter
- NINEPSB_ENABLED
- NINEPSB_WAAS_BASE_URL
- NINEPSB_WAAS_USERNAME
- NINEPSB_WAAS_PASSWORD
- NINEPSB_WAAS_CLIENT_ID
- NINEPSB_WAAS_CLIENT_SECRET
- NINEPSB_VAS_BASE_URL
- NINEPSB_VAS_USERNAME
- NINEPSB_VAS_PASSWORD

These variables only describe secure configuration readiness. They do not activate API calls; the request/response contract and transaction lifecycle still need implementation.

## Wallet architecture
The existing 9iceMoney wallet and transaction ledger remain authoritative. Provider accounts are stored independently at wallet_accounts/{userId}/accounts/{provider}. The legacy wallet_accounts/{userId} record remains the stable primary account for backward compatibility.