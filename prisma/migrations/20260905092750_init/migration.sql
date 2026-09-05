-- CreateEnum
CREATE TYPE "CreativeStatus" AS ENUM ('PENDING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "creatives" (
    "id" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" "CreativeStatus" NOT NULL DEFAULT 'PENDING',
    "body" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creatives_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "creatives_channel_createdAt_idx" ON "creatives"("channel", "createdAt");
