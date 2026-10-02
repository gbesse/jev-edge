# Security policy

Report vulnerabilities through GitHub Security Advisories. Do not attach model credentials or private inference inputs.

Jev Edge talks only to explicitly configured loopback endpoints and does not launch model processes. A loopback service still has the permissions of its own process and may make external network calls; sandbox it separately.
