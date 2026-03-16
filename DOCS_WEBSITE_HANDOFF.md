# TraderClaw Docs Website Handoff

This document is the implementation brief for the team setting up a public documentation site and publishing the install guide from `INSTALL_ZERO_TO_HERO.md`.

## Goal

Launch a production docs site at:

- `https://docs.traderclaw.ai`

with a polished docs experience similar to modern API/documentation portals (search, sidebar navigation, responsive layout, dark mode, and clean typography).

## Scope

### In scope

- Create docs site framework
- Convert existing markdown guides into docs pages
- Configure DNS and SSL for `docs.traderclaw.ai`
- Deploy with CI/CD
- Apply baseline branding and navigation

### Out of scope (for first release)

- Full multi-version docs strategy
- Translations/i18n
- Advanced analytics dashboards

---

## Recommended Stack (Primary Path)

- Framework: **Docusaurus**
- Host: **Cloudflare Pages** (or Vercel equivalent)
- Domain: **docs.traderclaw.ai**
- Source control: GitHub repository for docs

Why this stack:
- markdown-native authoring
- strong documentation UX by default
- flexible theming and branding
- straightforward deploy pipeline

---

## Information Architecture (v1)

Proposed docs structure:

- Getting Started
  - Zero to Hero Install (event-driven required)
  - OpenClaw Install (prereq)
- Installation Contract
  - Install Contract v1.0.7
- External Integrations
  - External Tailscale Installer Guide
- GUI Installer
  - GUI Installer Operator Guide
- Troubleshooting
  - Common errors and fixes

Initial source files to import:

- `openclaw-plugin/INSTALL_ZERO_TO_HERO.md`
- `openclaw-plugin/INSTALL_CONTRACT_v1.0.7.md`
- `openclaw-plugin/README_EXTERNAL_TAILSCALE_INSTALLER.md`
- `GUI_Installer/INSTALLER_OPERATOR_GUIDE.md`

---

## DNS + Domain Setup

## 1) Create docs project on hosting platform

Use Cloudflare Pages or Vercel and connect the docs repository.

## 2) Add custom domain

Add:

- `docs.traderclaw.ai`

in the hosting dashboard.

## 3) DNS record

Create DNS entry based on hosting instructions:

- Usually: `CNAME docs -> <platform-provided-target>`
- If the platform requires `A/AAAA`, use those values

## 4) SSL

Enable automatic TLS certificate issuance.

## 5) Canonical routing

Optional but recommended:

- redirect `traderclaw.ai/docs` -> `https://docs.traderclaw.ai`

---

## Docusaurus Implementation Plan

## 1) Bootstrap

```bash
npx create-docusaurus@latest traderclaw-docs classic
cd traderclaw-docs
npm install
```

## 2) Add docs pages

Create folders:

- `docs/getting-started/`
- `docs/contract/`
- `docs/integrations/`
- `docs/gui-installer/`

Copy and adapt content from the source markdown files listed above.

## 3) Frontmatter requirements

Each page must include:

```md
---
id: <stable-id>
title: <human-readable title>
description: <1 sentence summary>
sidebar_position: <number>
---
```

## 4) Sidebar configuration

Define explicit groups in `sidebars.js`:

- Getting Started
- Installation Contract
- External Integrations
- GUI Installer
- Troubleshooting

## 5) Site config

Set in `docusaurus.config.js`:

- `title`: TraderClaw Docs
- `url`: `https://docs.traderclaw.ai`
- `baseUrl`: `/`
- navbar links: Docs, GitHub, TraderClaw
- footer links: Docs, Support, Legal

## 6) Styling

Use `src/css/custom.css` for:

- brand color palette
- typography tuning
- code block readability
- table spacing and callout styles

---

## Content Standards

All installation docs should follow these rules:

- plain language, short blocks, copy-paste ready commands
- one command block per action
- explicit expected outputs for validation commands
- event-driven path is primary for production setup
- highlight required prerequisites before first command
- no secrets in examples (mask tokens/keys)

---

## Deployment Pipeline

## Branch strategy

- `main` deploys to production
- PR preview deploys for review

## Build settings

- Build command: `npm run build`
- Output directory: `build`

## CI checks

- markdown lint (optional but recommended)
- link check (internal + external)
- build success required before merge

---

## Acceptance Criteria

The docs launch is complete when:

- `https://docs.traderclaw.ai` is live with valid TLS
- `INSTALL_ZERO_TO_HERO.md` is published as a polished docs page
- navigation works on desktop and mobile
- internal links and command blocks are verified
- team can update docs by editing markdown and merging PRs

---

## Suggested Execution Timeline

Day 1:
- scaffold site
- import core pages
- configure sidebar/navbar

Day 2:
- branding pass
- DNS + SSL + deploy
- QA and link verification

Day 3:
- final polish
- handoff to content owners

---

## Roles / Ownership

- Docs Engineer: framework, deploy, DNS integration
- Product/Tech Writer: content adaptation and clarity
- Reviewer (Trading/Ops): technical validation of commands/flows
- Maintainer: approves PRs and owns release cadence

---

## Optional Alternative (Managed Docs)

If speed is prioritized over full customization:

- Mintlify or GitBook can be used as managed alternatives.
- Keep the same IA and content standards.
- Still use `docs.traderclaw.ai` as custom domain.

---

## Appendix: Starter Task List

- [ ] Create `traderclaw-docs` repo
- [ ] Bootstrap Docusaurus
- [ ] Import `INSTALL_ZERO_TO_HERO.md`
- [ ] Import contract and installer guides
- [ ] Configure navbar/sidebar/footer
- [ ] Connect hosting platform
- [ ] Point DNS for `docs.traderclaw.ai`
- [ ] Validate TLS and redirects
- [ ] QA all command snippets
- [ ] Publish production

