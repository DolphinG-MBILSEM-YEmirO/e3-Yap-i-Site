# E3 Yapı website

This folder contains the static website and its Vercel contact-form function.

## Contact form setup

The contact form sends mail through Resend. In the Vercel project environment, configure:

- RESEND_API_KEY — provided by the Resend integration.
- CONTACT_EMAIL_FROM — a sender on a domain verified in Resend, for example: E3 Yapı <web@e3yapi.com.tr>.
- CONTACT_EMAIL_TO — one or more existing recipient mailboxes, separated by commas.

Add these values to the Production, Preview, and Development environments as needed. Do not commit API keys or .env.local.

Resend must verify the sender domain before it can send from that address. Keep the MX records used by the mailbox provider; the website's outgoing mail service does not create inboxes.
