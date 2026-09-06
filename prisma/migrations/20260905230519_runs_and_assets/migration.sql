-- Durable run history, and the image bytes a shared run needs to render.
--
-- The `creatives` table is dropped rather than kept. It came from the original
-- scaffold, models a text-nudge product this repository is no longer, and is
-- read and written by exactly nothing: the only Prisma call in the app before
-- this migration was `SELECT 1` in the health probe. Keeping an empty table
-- that describes the wrong product is worse than a clean drop.
--
-- This is the migration that makes `preDeploy` in .railway/railway.ts load
-- bearing. Enabling it there is part of the same change: without it these
-- tables do not exist on Railway and the first write throws at request time.
-- CreateEnum
CREATE TYPE "RunKind" AS ENUM ('GENERATION', 'SCORING');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('RUNNING', 'OK', 'BLOCKED', 'FAILED');

-- DropTable
DROP TABLE "creatives";

-- DropEnum
DROP TYPE "CreativeStatus";

-- CreateTable
CREATE TABLE "runs" (
    "id" TEXT NOT NULL,
    "kind" "RunKind" NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "summary" TEXT NOT NULL DEFAULT '',
    "subject" TEXT,
    "productUrl" TEXT,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "inputs" JSONB NOT NULL DEFAULT '{}',
    "payload" JSONB,
    "error" TEXT,
    "assetShas" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_assets" (
    "sha256" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "byteSize" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_assets_pkey" PRIMARY KEY ("sha256")
);

-- CreateIndex
CREATE INDEX "runs_startedAt_idx" ON "runs"("startedAt" DESC);

-- CreateIndex
CREATE INDEX "runs_kind_startedAt_idx" ON "runs"("kind", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "runs_productUrl_startedAt_idx" ON "runs"("productUrl", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "run_assets_createdAt_idx" ON "run_assets"("createdAt");
