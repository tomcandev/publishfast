# PublishFast Agent Guide

Universal instruction manual and architectural reference for AI agents working in this repository

## Mission and Core Philosophy

PublishFast is a manual-first content distribution queue for short-form social video and carousel content.

Unlike automated social schedulers (Buffer, Postiz, Mixpost) that push content via official platform APIs, PublishFast intentionally preserves the human posting step. Native posting inside TikTok, Instagram, YouTube Shorts, and Facebook preserves critical platform features: trending in-app sounds, native text stickers, filters, cover selection, algorithmic freshness, and platform-specific UI nuances.

PublishFast streamlines everything around that human action:
* Instant content intake via AI ingestion API
* One-tap atomic claim for KOLs so no two creators grab the same post
* Fast media download (single video file or zipped image carousels)
* One-click caption copy to clipboard
* Multi-platform URL submission for verifiable proof of work
* Complete creator isolation and audit trail

## Architecture and Stack

* Monorepo managed with npm workspaces (`server` and `web`)
* Runtime: Node.js 22 LTS
* Server: Fastify 5, Drizzle ORM, better-sqlite3 with WAL mode and 5000ms busy timeout
* Frontend: React 19, TypeScript, Vite 6, React Router 7, vanilla CSS design tokens
* Authentication: Session cookies (humans) with Argon2id hashing and Jose JWT sessions, Bearer tokens (machines/AI) with SHA-256 hashes
* Media storage: Local disk streaming with multipart upload (`@fastify/multipart`) and zip generation (`archiver`)
* License constraint: 100% permissive dependencies only (MIT / Apache-2.0). Never introduce source-available, AGPL, or restrictive licenses

```
┌─────────────────────────────────────────────────────────────┐
│                      PublishFast Queue                      │
│                                                             │
│  [AI Ingest / Machine API]  ──Bearer Token──▶  POST /ingest │
│                                                     │       │
│                                                     ▼       │
│                                                [SQLite DB]  │
│                                                     │       │
│  [KOL Mobile / Desktop Web] ──Session Cookie─▶ POST /claim  │
└─────────────────────────────────────────────────────────────┘
```

## Repository Structure

```
publishfast/
├── docs/                     # Technical specifications and guides
│   ├── ai-ingestion-guide.md # AI content generator pipeline guide & scripts
│   ├── api.md                # Full HTTP API and ingestion schema
│   ├── data-model.md         # Schema definitions and status state machine
│   └── deployment.md         # Systemd, Cloudflare Tunnel, backup procedures
├── deploy/                   # Production deployment configs
│   └── publishfast.service   # Systemd service unit template
├── server/                   # Backend Fastify application
│   ├── src/
│   │   ├── db/               # Schema, migrations, sqlite connection
│   │   ├── lib/              # Auth, claim lock, config, guards
│   │   ├── routes/           # Auth, contents, publications, assets, ingest, admin
│   │   └── scripts/          # Database seed scripts
│   └── tsconfig.json
├── web/                      # Frontend Vite + React application
│   ├── src/
│   │   ├── components/       # Reusable UI primitives
│   │   ├── lib/              # API client and auth context
│   │   ├── pages/            # Login, Queue, Post, Admin, History
│   │   └── styles.css        # Minimalist design system tokens
│   └── vite.config.ts
├── AGENTS.md                 # Universal AI agent instructions (this file)
├── CLAUDE.md                 # Claude code reference pointing to AGENTS.md
├── package.json              # Workspace root scripts
└── plan.txt                  # Original foundational design specification
```

## Critical Business Logic and Invariants

### 1. Atomic Compare-And-Swap Claim Lock
Two KOLs must never claim or hold the same piece of content.
The claim transition is implemented in [`server/src/lib/claim.ts`](file:///Users/tom/Desktop/tomcandev/projects/publishfast/server/src/lib/claim.ts) using a single SQL UPDATE with CAS semantics:

```sql
UPDATE contents
SET status = 'CLAIMED', claimed_by = ?, claimed_at = ?
WHERE id = ? AND status = 'READY' AND (assigned_user_id IS NULL OR assigned_user_id = ?)
```

SQLite serializes writes in WAL mode. `changes === 1` indicates successful claim. `changes === 0` means the item was already claimed or does not exist. Never replace this with a read-then-write sequence.

### 2. Strict KOL Isolation
A KOL can only see and access:
* Content with `status = 'READY'` that is either unassigned or explicitly assigned to their user ID
* Content that they currently hold with `status = 'CLAIMED'`
* Publications and assets linked to contents they are authorized to access

All unauthorized requests must return `404 Not Found` rather than `403 Forbidden` to prevent resource ID enumeration.

### 3. Dual Login Identifier
The login endpoint accepts either a `username` or an `email` in a single input field. Usernames are strictly validated to never contain the `@` character, preventing namespace collisions with email addresses.

### 4. Media Asset Access Control
Asset paths on disk are never sent to clients. All downloads and previews flow through `/api/assets/:id` or `/api/contents/:id/assets.zip`, which evaluate parent content permissions on every request.

### 5. Content Lifecycle State Machine
* `DRAFT`: Ingested or created, hidden from KOL queue
* `READY`: Available in queue for claim
* `CLAIMED`: Held by exactly one KOL
* `PUBLISHED`: Completed with at least one verified social media publication URL
* `FAILED`: Error state or cancelled item

## Common Commands and Workflows

### Installation and Development
```bash
# Install all workspace dependencies
npm install

# Seed default admin (tom) and test KOL (yoga)
npm run seed

# Seed with custom credentials and machine token
PF_ADMIN_USER=tom PF_ADMIN_PASS=secret123 \
PF_KOL_USER=yoga PF_KOL_PASS=yogapass \
PF_CREATE_TOKEN=ai-pipeline \
npm run seed

# Start development servers (Server on :8055, Web on :5173 with proxy)
npm run dev
```

### Testing and Validation
```bash
# Run backend concurrency and claim-lock unit tests
npm test

# Typecheck server and web workspaces
npm run build
```

### Production Build and Execution
```bash
# Compile web frontend and server typescript
npm run build

# Start production server (serves API and static SPA on PORT)
npm start
```

## AI Ingestion Pipeline Quick Reference

Content generators push new media items using Bearer token authentication:

1. Create content entry:
```bash
POST /api/ingest/contents
Authorization: Bearer <TOKEN>
Content-Type: application/json

{
  "code": "PTE-RS-001",
  "title": "Repeat Sentence Tips",
  "caption": "Proven strategy for PTE...",
  "contentType": "video",
  "status": "READY"
}
```

2. Upload media assets (streamed directly to disk):
```bash
POST /api/ingest/contents/:contentId/assets
Authorization: Bearer <TOKEN>
Content-Type: multipart/form-data (field: file)
```

## Engineering Rules for AI Collaborators

* **Strict English Codebase Standard**: All code, features, variable names, functions, comments, UI text, labels, user-facing copy, error messages, docs, and git commit messages MUST be written strictly in English. Only direct conversational communication/replies with the user may be in Vietnamese.
* **Content Moderation & Soft Archival**: When addressing underperforming, duplicate, or flagged posts in the queue, prefer setting `status = 'DRAFT'` (soft-archiving/hiding from KOL queues) rather than hard-deleting immediately, so historical logs and proof-of-work audits are preserved.
* **Content Generation Hook Quality Standards**:
  - Focus on high-intent, high-value hooks: Score transformations (e.g. "From 58 to 88"), high-scoring question types (Write From Dictation, Repeat Sentence), mistake diagnostics, and concrete urgency game plans.
  - Avoid vague, generic, or low-CTR conversational hooks (e.g., avoid "Boss: Can we talk?").
* **Daily Content Generation Split (3 Standard + 2 Viral 2K)**:
  - Every daily batch generates **5 posts total**:
    - **3 Posts**: Standard 4-slide format (`assemble.py`).
    - **2 Posts**: Viral 2K 7-slide format (`assemble_viral_2k.py`), modeled after the 2,149-view viral video (`@english.deeper`).
  - **Viral 2K Standards**:
    - **100% Candid Camera Photography**: Real student selfies holding phones with scores, physical A4 Pearson scorecards (88-90), mirror selfies, real hands crossing planners with red pens, real subway commute, cozy sofa study, and campus celebrations. Zero 2D drawings or vector illustrations.
    - **Bold Rounded Typography**: `Arial Rounded Bold` / `Rubik Black` / `Montserrat Black`, size `70–78pt`, pure white text with a smooth `9px` thick black stroke outline.
    - **7-Slide Storytelling Arc**: `[Hook & Result] -> [The Mistake] -> [The Mechanism] -> [Daily Habit] -> [The Technique] -> [The Tool] -> [CTA & Victory]`.
* **Anti-AI Detection & Creator Software Export Standard (`sanitizer.py`)**:
  - All carousel slide outputs must be processed through `sanitizer.py`:
    - **100% C2PA / JUMBF / Google SynthID metadata stripping**: Zero cryptographic AI provenance headers in exported files.
    - **Frequency Domain SynthID Disruption**: Inject subtle micro-dithering (`scale ~ 1.5`) to disrupt spatial frequency watermarking without degrading visual clarity.
    - **Authentic Creator Software Metadata Injection**: Injects genuine graphic photo-editor export signatures (`Adobe Photoshop 25.11`, `CapCut for iOS`, `Canva Editor`, `Apple Photos/iOS ImageIO`, `ColorSpace: sRGB`), exactly matching how creators naturally design and export carousels.
    - **Format**: Export as clean, high-quality editor JPEG (`quality=95, subsampling=0`).
* **Queue Backlog Throttling (> 15 items)**: The daily content generation pipeline monitors the PublishFast remaining queue count (`READY` + `CLAIMED`). If the backlog exceeds 15 posts, generation and upload (Steps 1-3) are automatically paused to prevent overwhelming KOL queues, while Step 4 (Daily Performance Report) continues to execute. Can be bypassed via `--force` or `FORCE_GENERATE=1`.
* Always preserve atomic CAS patterns for any state transitions
* Keep all dependencies strictly MIT or Apache-2.0
* Maintain route-level permission checks for all new endpoints
* Follow vanilla CSS tokens defined in [`web/src/styles.css`](file:///Users/tom/Desktop/tomcandev/projects/publishfast/web/src/styles.css) without introducing heavy UI frameworks
* Run `npm test` and `npm run build` after modifying server or web code to prevent regressions
* Automatically commit and push changes directly to GitHub after verifying tests and build pass, without waiting or asking for reminders

