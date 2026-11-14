# 9iceMoney gateway branding and compatibility

The gateway's public root health response identifies the service as **9iceMoney Payment Gateway**.

This repository uses the package name `9icemoney-payment-gateway`. The PM2 process name, deployment paths, server hostnames, API route prefixes, environment variable names, Firebase project ID, service-account identity, webhook URLs, and provider credentials are intentionally not renamed by this branding change. Those values are operational integration identifiers and require a separately coordinated deployment migration if they ever need to change.

Do not expose provider secret keys or webhook secrets to the frontend. The 9PSB provider must remain disabled until its official integration documentation, sandbox credentials, and production onboarding requirements have been received and reviewed.

Existing Flutterwave and Paystack API routes remain backward-compatible.
